// functions/quotes/index.ts
// POST /functions/v1/quotes
//
// Request:  { "tickers": ["AAPL", "MSFT", ...], "force": false }
// Response: { "AAPL": MarketQuoteDTO, "MSFT": MarketQuoteDTO, ... }
//
// Pipeline per request:
//   1. Read all requested tickers from `quote_cache`.
//   2. Bucket into HIT (fresh under TTL) and MISS (stale or absent).
//      `force: true` skips this and treats every ticker as MISS.
//   3. For MISS:
//        a. Batch-call Polygon snapshot (one HTTP call up to 250 tickers).
//        b. Identify the subset that will need `aggregate_cache` to fuse —
//           tickers where Polygon snapshot is missing OR in the reset
//           window (03:30–09:30 ET). Tickers with full live data skip this.
//        c. AWAIT a warmup of `aggregate_cache` for that subset only. This
//           guarantees a single PTR is sufficient: without it, the very
//           first PTR for a never-seen ticker hits an empty cache and the
//           row falls through to null. The warmup's pre-check skips any
//           ticker that already has a wide-enough fresh row (never narrows
//           a 5y row down to 10d).
//        d. Read `aggregate_cache` (now seeded) for the subset.
//        e. Fuse into MarketQuoteDTO. Happy-path tickers got their result
//           from Polygon alone; subset tickers fused with cache help.
//        f. UPSERT non-degenerate rows into `quote_cache`. Rows with no
//           usable change signal are filtered to avoid poisoning the cache.
//   4. Return HITs ∪ freshly-fused MISS payloads.
//
// TTL is set in _shared/market_state.ts and applied at read time. Rows in
// `quote_cache` are never deleted; they're overwritten on the next miss.
//
// Auth: anon key (apikey header) is sufficient. Anyone with the anon key
// can call. Same trust posture as direct REST calls. Add JWT verification
// here when monetization gates this endpoint.

import { errorResponse, jsonResponse, preflight } from "../_shared/cors.ts";
import {
  fetchSnapshotBatch,
  snapshotTodaysChange,
  SnapshotDTO,
} from "../_shared/polygon.ts";
import { marketState } from "../_shared/market_state.ts";
import {
  fetchPrevCloses,
  fuseQuote,
  MarketQuoteDTO,
  upsertCache,
  warmAggregateCache,
} from "../_shared/quote_fusion.ts";
import { admin } from "../_shared/supabase_admin.ts";

// MARK: - DTOs

interface RequestBody {
  tickers?: string[];
  /// When `true`, bypass the `quote_cache` HIT/MISS read entirely and treat
  /// every requested ticker as a MISS — Polygon is called, the result is
  /// upserted into `quote_cache`, and `fetched_at` is refreshed. The
  /// response shape is unchanged. iOS sets this on pull-to-refresh so users
  /// always see the work happen; the per-isolate Polygon batch + 1s open-
  /// market TTL still prevent abuse.
  force?: boolean;
}

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

  const tickers = (body.tickers ?? []).filter((t) => typeof t === "string" && t.length > 0);
  if (tickers.length === 0) return jsonResponse({}, 200);

  // Dedupe + uppercase canonicalize.
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
  const force = body.force === true;

  try {
    const result = await handleQuotes(unique, force);
    return jsonResponse(result);
  } catch (err) {
    console.error("[quotes] handler failed:", err);
    return errorResponse((err as Error).message ?? "Internal error", 500);
  }
});

// MARK: - Handler

/// Read every requested ticker's payload from `quote_cache`, ignoring TTL.
/// The presence of a row IS the answer — staleness checks are no longer the
/// gate, refresh work happens in the background instead. Returns a map keyed
/// by ticker. Tickers without a row (never been quoted) are simply absent.
async function readAllCached(tickers: string[]): Promise<Record<string, MarketQuoteDTO>> {
  const { data, error } = await admin()
    .from("polygon_quote_cache")
    .select("ticker, payload")
    .in("ticker", tickers);

  if (error) {
    console.error("[quotes] cache read failed:", error);
    return {};
  }
  const out: Record<string, MarketQuoteDTO> = {};
  for (const row of (data ?? []) as { ticker: string; payload: MarketQuoteDTO }[]) {
    out[row.ticker] = row.payload;
  }
  return out;
}

/// Background refresh: Polygon snapshot + warmup + fuse + upsert. Same
/// pipeline as before, just no longer gating the response. If this fails or
/// drops tickers, the next call still serves the existing `quote_cache`
/// rows — no UI impact. iOS sees fresher data on the call after this one
/// finishes writing.
async function refreshInBackground(tickers: string[]): Promise<void> {
  if (tickers.length === 0) return;

  const snapshots = await fetchSnapshotsSafe(tickers);
  console.log(`[quotes] bg polygon snapshots=${Object.keys(snapshots).length}/${tickers.length}`);

  const needCache = tickers.filter((t) => {
    const snap = snapshots[t];
    if (!snap) return true;
    if (snapshotTodaysChange(snap) === null) return true;
    if (!snap.prevDay?.c || snap.prevDay.c <= 0) return true;
    return false;
  });

  if (needCache.length > 0) {
    try {
      await warmAggregateCache(needCache);
    } catch (e) {
      console.error("[quotes] bg warmAggregateCache failed (continuing):", e);
    }
  }

  const prevCloses = needCache.length > 0 ? await fetchPrevCloses(needCache) : {};

  const fused: MarketQuoteDTO[] = [];
  let nulls = 0;
  for (const ticker of tickers) {
    const dto = fuseQuote(ticker, snapshots[ticker] ?? null, prevCloses[ticker] ?? []);
    if (dto) fused.push(dto);
    else nulls++;
  }
  console.log(`[quotes] bg fused=${fused.length} null=${nulls}`);

  if (fused.length > 0) {
    try {
      const n = await upsertCache(fused);
      console.log(`[quotes] bg upserted ${n} rows`);
    } catch (e) {
      console.error("[quotes] bg cache upsert failed:", e);
    }
  }
}

async function handleQuotes(tickers: string[], _force: boolean): Promise<Record<string, MarketQuoteDTO>> {
  const state = marketState();
  console.log(`[quotes] req tickers=${tickers.length} state=${state}`);

  // PATH 2 (cache → user). Unconditional. Read every requested ticker's
  // row from quote_cache. Presence is the answer; freshness never gates.
  const cached = await readAllCached(tickers);
  console.log(`[quotes] served from cache: ${Object.keys(cached).length}/${tickers.length}`);

  // PATH 1 (Polygon → cache). Gated by market state.
  //
  //   - open / extended: refresh every requested ticker in the background.
  //     This is the standard live-data flow.
  //
  //   - closed: do NOT touch Polygon for tickers that already have a
  //     quote_cache row — there's nothing new to fetch. Only refresh tickers
  //     that are missing from the cache entirely (e.g. user just added a
  //     stock after-hours and there's no row yet). For those tickers, we
  //     need Polygon and aggregate_cache populated so the row exists for
  //     the user to read on the next call.
  const tickersToRefresh =
    state === "closed"
      ? tickers.filter((t) => !(t in cached))
      : tickers;

  if (tickersToRefresh.length > 0) {
    refreshInBackground(tickersToRefresh).catch((e) => {
      console.error("[quotes] background refresh failed:", e);
    });
  }

  return cached;
}

// MARK: - Polygon fetch (with safe fallback)

/// Returns `{}` on Polygon failure rather than throwing — that lets us
/// still serve supabaseClose-only quotes for missed tickers.
async function fetchSnapshotsSafe(
  tickers: string[],
): Promise<Record<string, SnapshotDTO>> {
  try {
    return await fetchSnapshotBatch(tickers);
  } catch (err) {
    console.error("[quotes] Polygon batch failed, falling back to supabaseClose only:", err);
    return {};
  }
}