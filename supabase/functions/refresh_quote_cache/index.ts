// functions/refresh_quote_cache/index.ts
// POST /functions/v1/refresh_quote_cache — cron-triggered every minute.
//
// Keeps polygon_quote_cache warm so the iOS watchlist shows minute-fresh
// prices without a pull-to-refresh. Distinct from /tick (which writes
// price_snapshots for the alert evaluator): this writes ONLY quote_cache.
//
// Pipeline:
//   1. Bail if outside the trading window (same gate as /tick).
//   2. Read every ticker currently in quote_cache — that IS the set of
//      stocks any user has ever watched. Newly-added tickers are seeded
//      on-add by /quotes, so they fold in on the next minute automatically.
//   3. Batch-fetch Polygon snapshots, warm aggregate_cache where needed,
//      fuse, and upsert back into quote_cache (shared quote_fusion logic).
//
// Auth: called by pg_cron with the service-role bearer, same as /tick.

import { errorResponse, jsonResponse, preflight } from "../_shared/cors.ts";
import { fetchSnapshotBatch, snapshotTodaysChange, SnapshotDTO } from "../_shared/polygon.ts";
import { admin } from "../_shared/supabase_admin.ts";
import { isTickWindowOpen, tickWindowLabel } from "../_shared/market_window.ts";
import {
  fetchPrevCloses,
  fuseQuote,
  MarketQuoteDTO,
  upsertCache,
  warmAggregateCache,
} from "../_shared/quote_fusion.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  if (!isTickWindowOpen()) {
    return jsonResponse({ skipped: tickWindowLabel() }, 200);
  }

  try {
    const refreshed = await refreshAll();
    return jsonResponse({ refreshed });
  } catch (err) {
    console.error("[refresh_quote_cache] handler failed:", err);
    return errorResponse((err as Error).message ?? "Internal error", 500);
  }
});

/// Refresh every ticker already present in quote_cache.
async function refreshAll(): Promise<number> {
  const tickers = await readCachedTickers();
  if (tickers.length === 0) return 0;

  const snapshots = await fetchSnapshotsSafe(tickers);

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
      console.error("[refresh_quote_cache] warmAggregateCache failed (continuing):", e);
    }
  }

  const prevCloses = needCache.length > 0 ? await fetchPrevCloses(needCache) : {};

  const fused: MarketQuoteDTO[] = [];
  for (const ticker of tickers) {
    const dto = fuseQuote(ticker, snapshots[ticker] ?? null, prevCloses[ticker] ?? []);
    if (dto) fused.push(dto);
  }

  if (fused.length === 0) return 0;
  return await upsertCache(fused);
}

/// Read the full set of tickers currently in quote_cache.
async function readCachedTickers(): Promise<string[]> {
  const { data, error } = await admin()
    .from("polygon_quote_cache")
    .select("ticker");
  if (error) {
    console.error("[refresh_quote_cache] ticker read failed:", error);
    return [];
  }
  return (data ?? []).map((r: { ticker: string }) => r.ticker);
}

/// Returns {} on Polygon failure rather than throwing.
async function fetchSnapshotsSafe(tickers: string[]): Promise<Record<string, SnapshotDTO>> {
  try {
    return await fetchSnapshotBatch(tickers);
  } catch (err) {
    console.error("[refresh_quote_cache] Polygon batch failed:", err);
    return {};
  }
}
