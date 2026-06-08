// functions/refresh_aggregate_cache/index.ts
// POST /functions/v1/refresh_aggregate_cache — cron-triggered daily pre-open.
//
// Keeps polygon_aggregate_cache warm for the N-day alert evaluator
// (price_move_nd), which reads its reference close from this cache. Warms
// the union of every enabled-alert stock ticker over a 365-day window
// (adjusted=true) — matching what iOS charts fetch, far more than any N
// needs. Reuses quote_fusion.warmAggregateCache (coverage-aware, widens
// never narrows). Stocks only; indices are skipped.
//
// This is the daily safety-net path. Same-minute availability for a newly
// added alert is handled separately by /tick's lazy warm, not here.
//
// Auth: called by pg_cron with the service-role bearer, same as /tick.

import { jsonResponse, errorResponse, preflight } from "../_shared/cors.ts";
import { admin } from "../_shared/supabase_admin.ts";
import { warmAggregateCache } from "../_shared/quote_fusion.ts";
import { isIndex } from "../_shared/polygon.ts";

const WARM_DAYS = 365;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const startedAt = Date.now();
  try {
    const tickers = await enabledAlertStockTickers();
    await warmAggregateCache(tickers, WARM_DAYS);
    return jsonResponse({
      ok: true,
      tickers: tickers.length,
      lookback_days: WARM_DAYS,
      duration_ms: Date.now() - startedAt,
    });
  } catch (err) {
    console.error("[refresh_aggregate_cache] failed:", err);
    return errorResponse((err as Error).message ?? "refresh failed", 500);
  }
});

/// Distinct stock tickers across all enabled alerts. Indices excluded.
async function enabledAlertStockTickers(): Promise<string[]> {
  const { data, error } = await admin()
    .from("user_alerts")
    .select("ticker")
    .eq("enabled", true);
  if (error) throw new Error(`alerts load failed: ${error.message}`);
  const set = new Set<string>();
  for (const r of (data ?? []) as Array<{ ticker: string }>) {
    const t = r.ticker.toUpperCase();
    if (!isIndex(t)) set.add(t);
  }
  return [...set];
}
