// functions/aggregates/index.ts
// POST /functions/v1/aggregates
//
// Request:  { "ticker": "PLTR", "from": "2024-05-01", "to": "2026-05-08", "adjusted": true, "force": false }
// Response: { "bars": [ { c, h, l, o, v, t }, ... ] }
//
// Used by iOS for historical bars (sparklines, charts, on-device VaR /
// return / reversal computation). Cache TTL is 24h — historical bars
// don't change once published. Today's intraday bar is acceptable to be
// stale until the next morning; pull-to-refresh with `force: true`
// bypasses the cache read but still upserts (so `fetched_at` refreshes
// as proof of work).
//
// Cache shape: `aggregate_cache` Supabase table (migration 013). Keyed by
// (ticker, adjusted) — ONE row per ticker per adjustment flag. The row's
// `from_date` and `to_date` describe whatever window is currently held in
// `bars`. Each upsert is allowed to widen that window (never narrow it):
// callers ask for whatever range they need, and the row monotonically
// grows toward "everything we've ever requested for this ticker."
//
// On request, we do a COVERAGE CHECK rather than an exact-key match:
//   - Cached row covers requested range AND is fresh → slice bars and return.
//   - Otherwise → fetch from Polygon for the union (cached ∪ requested),
//     upsert the widened window, return the requested slice.
//
// On Polygon failure, falls back to any existing cached row if it covers
// the requested range — better to serve a slice of stale data than fail.
//
// Auth: anon key only. Same posture as /quotes.

import { errorResponse, jsonResponse, preflight } from "../_shared/cors.ts";
import { fetchAggregates, AggregateBarDTO } from "../_shared/polygon.ts";
import { admin } from "../_shared/supabase_admin.ts";

/// Keep the isolate alive until background work settles; no-ops in local dev.
function waitUntil(promise: Promise<unknown>): void {
  (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } })
    .EdgeRuntime?.waitUntil(promise);
}

interface RequestBody {
  ticker?: string;
  from?: string;
  to?: string;
  adjusted?: boolean;
  /// When `true`, bypass the cache read entirely and re-fetch from Polygon.
  /// The upsert still runs, so `fetched_at` refreshes. iOS uses this for
  /// explicit user-driven refresh actions on charts.
  force?: boolean;
}

interface ResponseBody {
  bars: AggregateBarDTO[];
}

interface CacheRow {
  ticker: string;
  from_date: string;
  to_date: string;
  adjusted: boolean;
  bars: AggregateBarDTO[];
  fetched_at: string;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours

// MARK: - Entry point

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const ticker = (body.ticker ?? "").toUpperCase();
  const from = body.from ?? "";
  const to = body.to ?? "";
  const adjusted = body.adjusted ?? true;
  const force = body.force === true;

  if (!ticker) return errorResponse("Missing 'ticker'", 400);
  if (!isoDate(from)) return errorResponse("Invalid 'from' (expected YYYY-MM-DD)", 400);
  if (!isoDate(to)) return errorResponse("Invalid 'to' (expected YYYY-MM-DD)", 400);
  if (from > to) return errorResponse("'from' must be <= 'to'", 400);

  // Read the single cached row for this (ticker, adjusted). Used in three
  // places: coverage hit, union-window fetch on miss, and stale fallback
  // on Polygon failure.
  const cached = await readCache(ticker, adjusted);
  const fresh = cached !== null && (Date.now() - Date.parse(cached.fetched_at)) < CACHE_TTL_MS;
  const covers = cached !== null && cached.from_date <= from && cached.to_date >= to;
  // An empty-bars row passes the date-range coverage check trivially but
  // carries no actual data — treat it as if the row weren't there. This
  // can happen when Polygon previously returned 0 results (wrong ticker
  // format, temporarily uncovered, transient API failure) and we cached
  // the empty result. Without this guard, the row keeps serving empty
  // bars on every subsequent request until the 24h TTL expires.
  const hasBars = cached !== null && Array.isArray(cached.bars) && cached.bars.length > 0;

  if (!force && cached && fresh && covers && hasBars) {
    const sliced = sliceBars(cached.bars, from, to);
    console.log(`[aggregates] HIT ${ticker} ${from}→${to} adjusted=${adjusted} (cached ${cached.from_date}→${cached.to_date}, sliced ${sliced.length}/${cached.bars.length})`);
    return jsonResponse({ bars: sliced } satisfies ResponseBody);
  }

  // Compute the union window so we widen the cache row instead of
  // narrowing it. If the cached row has no bars, there's nothing
  // meaningful to preserve — start fresh from the requested range.
  const fetchFrom = (cached && hasBars) ? minDate(cached.from_date, from) : from;
  const fetchTo = (cached && hasBars) ? maxDate(cached.to_date, to) : to;

  const stateLabel = force ? "FORCE"
    : !cached ? "MISS"
      : !hasBars ? "EMPTY"
        : !covers ? "PARTIAL"
          : "STALE";
  console.log(`[aggregates] ${stateLabel} ${ticker} req=${from}→${to} fetch=${fetchFrom}→${fetchTo} adjusted=${adjusted}`);

  try {
    const bars = await fetchAggregates(ticker, fetchFrom, fetchTo, adjusted);
    // Don't upsert a fresh empty result over a populated row — that would
    // clobber good data with garbage. If we don't already have populated
    // bars, write whatever we got (even if empty) so the next request can
    // route through the EMPTY branch and retry.
    if (bars.length > 0 || !hasBars) {
      waitUntil(
        upsertCache(ticker, fetchFrom, fetchTo, adjusted, bars)
          .then(() => console.log(`[aggregates] upserted ${ticker} ${fetchFrom}→${fetchTo} bars=${bars.length}`))
          .catch((e) => console.error(`[aggregates] upsert failed for ${ticker}:`, e)),
      );
    } else {
      console.log(`[aggregates] declined to overwrite populated row with 0 bars for ${ticker}`);
    }
    // Return only the slice the caller asked for, not the widened window.
    return jsonResponse({ bars: sliceBars(bars, from, to) } satisfies ResponseBody);
  } catch (err) {
    console.error(`[aggregates] ${ticker} ${fetchFrom}→${fetchTo} polygon failed:`, err);
    // Serve stale on Polygon failure, but only if the cached window
    // covers what was asked AND has bars. A non-covering or empty-bars
    // stale row would mislead the caller into thinking they got their
    // full range.
    if (cached && covers && hasBars) {
      const sliced = sliceBars(cached.bars, from, to);
      console.log(`[aggregates] serving stale ${ticker} sliced=${sliced.length}`);
      return jsonResponse({ bars: sliced } satisfies ResponseBody);
    }
    return errorResponse((err as Error).message ?? "Internal error", 502);
  }
});

// MARK: - Cache I/O

async function readCache(
  ticker: string,
  adjusted: boolean,
): Promise<CacheRow | null> {
  const { data, error } = await admin()
    .from("polygon_aggregate_cache")
    .select("ticker, from_date, to_date, adjusted, bars, fetched_at")
    .eq("ticker", ticker)
    .eq("adjusted", adjusted)
    .maybeSingle();

  if (error) {
    console.error("[aggregates] cache read failed:", error);
    return null;
  }
  return (data as CacheRow | null) ?? null;
}

async function upsertCache(
  ticker: string,
  from: string,
  to: string,
  adjusted: boolean,
  bars: AggregateBarDTO[],
): Promise<void> {
  const row = {
    ticker,
    from_date: from,
    to_date: to,
    adjusted,
    bars,
    fetched_at: new Date().toISOString(),
  };
  const { error } = await admin()
    .from("polygon_aggregate_cache")
    .upsert(row, { onConflict: "ticker,adjusted" });
  if (error) throw error;
}

// MARK: - Helpers

function isoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function minDate(a: string, b: string): string { return a < b ? a : b; }
function maxDate(a: string, b: string): string { return a > b ? a : b; }

/// Filter `bars` to those whose business date falls within [from, to]
/// inclusive. Bars carry `t` in milliseconds since epoch (UTC), so we
/// project to America/New_York date — matching the way `from`/`to` are
/// interpreted everywhere else in the codebase.
function sliceBars(bars: AggregateBarDTO[], from: string, to: string): AggregateBarDTO[] {
  return bars.filter((bar) => {
    const d = businessDateNY(bar.t);
    return d >= from && d <= to;
  });
}

/// Convert a bar's epoch-ms timestamp to a `YYYY-MM-DD` string in
/// America/New_York. Same routine as /quotes uses for `aggregate_cache`
/// bars; copied here to avoid a cross-function shared module just for one
/// helper.
function businessDateNY(ms: number): string {
  if (!ms || ms <= 0) return "";
  const d = new Date(ms);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}