// _shared/var_precompute.ts
// MVP — VaR threshold precompute for the alert evaluator.
//
// Called once at the top of /tick after the Polygon snapshot batch fetch.
// For every ticker with an enabled price_move_var alert, this function:
//   1. Reads the last N closes from stock_price (one batched query, ordered).
//   2. Computes daily log returns.
//   3. Computes the linear-interpolation percentile at the configured
//      confidence levels.
//
// Result is a Map<ticker, VarThresholds> that /tick passes to evaluators
// via EvalContext.varThresholds. Evaluators read O(1).
//
// Why not a separate table:
//   - /tick already touches stock_price; no extra round-trip outside of
//     this one batched read.
//   - VaR is derived; storing it would add nightly job + retention + sync.
//   - The math is cheap: O(N log N) sort per ticker, N ≈ 260.
//     For 100 tickers that's ~30ms in the Deno isolate.

import { admin } from "./supabase_admin.ts";

// MARK: - Types

export interface VarRequest {
  ticker: string;
  confidence: number;   // 0.90, 0.95, 0.99
  lookback: number;     // typically 252
}

export interface VarThresholds {
  /// Loss threshold (negative number). today's % ≤ var_pct_lower → "down" breach.
  var_pct_lower: number;
  /// Gain threshold (positive number). today's % ≥ var_pct_upper → "up" breach.
  var_pct_upper: number;
  /// Number of observations actually used (may be < lookback for new tickers).
  n_samples: number;
  /// Business date of the most recent close used.
  as_of_business_date: string;
}

// MARK: - Public

/// Collect the unique (ticker, confidence, lookback) tuples from a list of
/// alert rows. Returns a deduplicated array — different alerts on the same
/// (ticker, confidence, lookback) share one threshold.
export function collectVarRequests(
  alerts: Array<{ ticker: string; condition: Record<string, unknown> }>,
): VarRequest[] {
  const seen = new Set<string>();
  const out: VarRequest[] = [];
  for (const a of alerts) {
    if (a.condition.type !== "price_move_var") continue;
    const confidence = a.condition.confidence as number;
    const lookback   = (a.condition.lookback as number | undefined) ?? 252;
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) continue;
    const key = `${a.ticker}|${confidence}|${lookback}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ticker: a.ticker, confidence, lookback });
  }
  return out;
}

/// Compute VaR thresholds for every requested (ticker, confidence, lookback)
/// in a single batched query against stock_price.
///
/// The query reads more rows than strictly needed (max lookback across all
/// requests) and slices per request. That's still one DB round-trip for the
/// whole tick.
///
/// Returns a Map keyed by `${ticker}|${confidence}|${lookback}` so the
/// evaluator can index in O(1).
export async function computeVarThresholds(
  requests: VarRequest[],
): Promise<Map<string, VarThresholds>> {
  const out = new Map<string, VarThresholds>();
  if (requests.length === 0) return out;

  // Distinct tickers + the max lookback we need overall.
  const tickers = Array.from(new Set(requests.map((r) => r.ticker)));
  const maxLookback = Math.max(...requests.map((r) => r.lookback));

  // Single batched query: all tickers, last ~maxLookback trading days.
  // Trading-day count ≈ calendar-day count × 252/365, so add ~50% padding
  // to be safe across weekends and holidays. This is one round-trip
  // regardless of how many tickers are passed.
  const calendarDays = Math.ceil(maxLookback * 1.5) + 14;
  const cutoff = new Date(Date.now() - calendarDays * 86400_000)
    .toISOString().slice(0, 10);

  const { data, error } = await admin()
    .from("stock_price")
    .select("ticker, close, business_date")
    .in("ticker", tickers)
    .gte("business_date", cutoff)
    .order("ticker", { ascending: true })
    .order("business_date", { ascending: false });

  if (error) {
    console.error("[varPrecompute] batched stock_price read failed:", error);
    return out;
  }

  // Group by ticker, preserving the DESC-by-date ordering already applied.
  const closesByTicker = new Map<string, Array<{ close: number; business_date: string }>>();
  for (const row of (data ?? []) as Array<{ ticker: string; close: number; business_date: string }>) {
    const arr = closesByTicker.get(row.ticker) ?? [];
    arr.push({ close: row.close, business_date: row.business_date });
    closesByTicker.set(row.ticker, arr);
  }

  // Compute thresholds per request from the cached close arrays.
  for (const req of requests) {
    const closes = closesByTicker.get(req.ticker) ?? [];
    if (closes.length < 2) continue;

    // Slice to (lookback + 1) most recent rows, then re-order ascending for
    // intuitive return derivation. (close[i] − close[i-1]) / close[i-1] × 100.
    const wanted = closes.slice(0, Math.min(req.lookback + 1, closes.length));
    const asc = wanted.slice().reverse();
    const returns: number[] = [];
    for (let i = 1; i < asc.length; i++) {
      const prev = asc[i - 1].close;
      const cur  = asc[i].close;
      if (prev > 0 && Number.isFinite(prev) && Number.isFinite(cur)) {
        returns.push(((cur - prev) / prev) * 100);
      }
    }
    if (returns.length < 10) continue;   // not enough history

    // Sort once; percentile by linear interpolation.
    returns.sort((a, b) => a - b);
    const lowerQ = 1 - req.confidence;   // e.g. 0.05 for 95% confidence
    const upperQ = req.confidence;       // e.g. 0.95

    const lower = percentileSorted(returns, lowerQ);
    const upper = percentileSorted(returns, upperQ);

    const key = `${req.ticker}|${req.confidence}|${req.lookback}`;
    out.set(key, {
      var_pct_lower: round4(lower),
      var_pct_upper: round4(upper),
      n_samples: returns.length,
      as_of_business_date: closes[0].business_date,
    });
  }

  return out;
}

// MARK: - Internals

/// Linear-interpolation percentile (numpy's default `linear` method).
/// `sorted` must be ascending. `q` in [0, 1].
function percentileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
