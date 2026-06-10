// functions/quotes/index.ts
// POST /functions/v1/quotes
//
// Request:  { "tickers": ["AAPL", "MSFT", ...], "force": false }
// Response: { "AAPL": MarketQuoteDTO, "MSFT": MarketQuoteDTO, ... }
//
// Pipeline per request:
//   1. Read all requested tickers from `quote_cache`.
//   2. Bucket into HIT (fresh under TTL) and MISS (stale or absent).
//      `force` is accepted but ignored — the per-minute cron keeps the cache fresh.
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

/// Keep the isolate alive until background work settles; no-ops in local dev.
function waitUntil(promise: Promise<unknown>): void {
  (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } })
    .EdgeRuntime?.waitUntil(promise);
}

// MARK: - DTOs

interface RequestBody {
  tickers?: string[];
  /// Accepted for back-compat but intentionally a NO-OP. The per-minute
  /// refresh_quote_cache cron keeps quote_cache current, and the Polygon
  /// plan is 15-min delayed — a forced synchronous fetch would cost a
  /// Polygon call and return the same data the cache already holds.
  /// Remove from the iOS request body whenever convenient.
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

/// Polygon snapshot + warmup + fuse + upsert. Returns the freshly fused
/// DTOs keyed by ticker so callers can serve them in the same response.
/// When `forceCache` is true (cold/missing tickers) the aggregate warmup
/// runs for every ticker, guaranteeing the reset-window fallback has T-2
/// closes on this same pass — otherwise a never-seen ticker fuses to null
/// and no row is ever written. If this fails or drops tickers, the next
/// call still serves existing `quote_cache` rows — no UI impact.
async function refreshQuotes(
  tickers: string[],
  forceCache = false,
): Promise<Record<string, MarketQuoteDTO>> {
  if (tickers.length === 0) return {};

  const snapshots = await fetchSnapshotsSafe(tickers);
  console.log(`[quotes] bg polygon snapshots=${Object.keys(snapshots).length}/${tickers.length}`);

  const needCache = forceCache ? tickers : tickers.filter((t) => {
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
  const out: Record<string, MarketQuoteDTO> = {};
  let nulls = 0;
  for (const ticker of tickers) {
    const dto = fuseQuote(ticker, snapshots[ticker] ?? null, prevCloses[ticker] ?? []);
    if (dto) { fused.push(dto); out[ticker] = dto; }
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
  return out;
}

async function handleQuotes(tickers: string[], _force: boolean): Promise<Record<string, MarketQuoteDTO>> {
  const state = marketState();
  console.log(`[quotes] req tickers=${tickers.length} state=${state}`);

  // PATH 2 (cache → user). Unconditional. Read every requested ticker's
  // row from quote_cache. Presence is the answer; freshness never gates —
  // the per-minute refresh_quote_cache cron keeps rows current, and the
  // Polygon plan is 15-min delayed so a forced fetch would return the
  // same data anyway.
  const cached = await readAllCached(tickers);
  console.log(`[quotes] served from cache: ${Object.keys(cached).length}/${tickers.length}`);

  const missing = tickers.filter((t) => !(t in cached));
  const cachedExisting = tickers.filter((t) => t in cached);

  // PATH 1 (Polygon → cache).
  //
  // Missing tickers (no quote_cache row) are refreshed SYNCHRONOUSLY with
  // forceCache so the row is fused, written, AND served in this same
  // response — a single call after an add now shows the price. Pre-market
  // this surfaces yesterday's close via the aggregate fallback rather than
  // returning nothing.
  //
  // Already-cached tickers refresh in the background: every requested
  // ticker when open/extended (live updates), none when closed (nothing
  // new to fetch). waitUntil keeps the isolate alive past the response.
  if (missing.length > 0) {
    const fresh = await refreshQuotes(missing, true);
    for (const [k, v] of Object.entries(fresh)) cached[k] = v;
  }

  if (state !== "closed" && cachedExisting.length > 0) {
    waitUntil(
      refreshQuotes(cachedExisting).catch((e) => {
        console.error("[quotes] background refresh failed:", e);
      }),
    );
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