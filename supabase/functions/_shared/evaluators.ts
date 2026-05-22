// _shared/evaluators.ts
// The extensibility spine of the alerts feature. One function per alert
// type, indexed by `condition.type`. Adding a new type = one new evaluator
// function + one new line in the `evaluators` registry below. No schema
// migration, no /tick changes outside this file.
//
// The registry pattern is borrowed verbatim from pulsealert-backend.
// Shape evolution within a type is handled by `condition_v` on the alerts
// row — evaluators branch on it when the JSONB layout changes.
//
// ────────────────────────────────────────────────────────────────────────
// CONDITION SHAPES (v1)
//
// price_move_1d
//   { type: "price_move_1d", direction: "up"|"down"|"any", pct: 5 }
//   Fires when today's percent change vs previous close meets `pct`. The
//   percent value is pre-computed by Polygon and cached on each price_snapshot
//   row (`price_return`), so this evaluator is O(1) — no historical query.
//
// price_move_nd
//   { type: "price_move_nd", direction: "up"|"down"|"any", pct: 10, days: 5 }
//   Fires when the cumulative move from N business days ago to today meets
//   `pct`. Reference price comes from `stock_price` at the resolved business
//   date (N business days before today, looked up via `business_dates`).
//
// Direction semantics (both types):
//   "up"   → fires when actual_pct >= +abs(pct)
//   "down" → fires when actual_pct <= -abs(pct)
//   "any"  → fires when |actual_pct| >= abs(pct)
// ────────────────────────────────────────────────────────────────────────

import { admin } from "./supabase_admin.ts";

// ============================================================
// Types
// ============================================================

export interface EvalContext {
  /// Latest price the evaluator should compare against (i.e. "now"). For
  /// /tick this is the price we just fetched from Polygon and wrote to
  /// price_snapshots.
  currentPrice: number;

  /// Latest percent change vs previous close — Polygon's todaysChangePerc.
  /// Decimal percent (5.2 means 5.2%, not 0.052). Null if Polygon didn't
  /// provide it for this tick (reset window 03:30–09:30 ET).
  todaysChangePct: number | null;

  /// Today's business date in NY time (YYYY-MM-DD). Used by the N-day
  /// evaluator to anchor the date arithmetic.
  todayBusinessDate: string;
}

export interface EvalResult {
  fired: boolean;
  /// The price the move was measured against. For 1-day: previous close.
  /// For N-day: close N business days ago.
  referencePrice?: number;
  /// Actual move, as decimal percent (e.g. 5.2 for 5.2%).
  movePct?: number;
  /// Free-form evaluator output written to alert_fires.context for audit.
  context?: Record<string, unknown>;
}

export type Evaluator = (
  ticker: string,
  condition: Record<string, unknown>,
  ctx: EvalContext,
) => Promise<EvalResult>;

// ============================================================
// Direction helper — used by every percent-based evaluator.
// ============================================================

/// Returns true if `actualPct` meets the threshold for the given direction.
/// abs() on `thresholdPct` so callers can pass either signed or unsigned.
function meetsThreshold(
  direction: string,
  actualPct: number,
  thresholdPct: number,
): boolean {
  const t = Math.abs(thresholdPct);
  if (direction === "up")   return actualPct >=  t;
  if (direction === "down") return actualPct <= -t;
  if (direction === "any")  return Math.abs(actualPct) >= t;
  return false;
}

// ============================================================
// price_move_1d — 1-day percent change
// ============================================================
//
// Uses Polygon's pre-computed todaysChangePerc. If the snapshot didn't
// include it (reset window), we have no signal and return fired=false.
// /tick will retry next minute. No fallback to stock_price here — the
// 1-day eval is meant to be O(1).

const evalPriceMove1d: Evaluator = async (_ticker, condition, ctx) => {
  const direction = condition.direction as string;
  const pct       = condition.pct as number | undefined;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return { fired: false };
  if (ctx.todaysChangePct === null) return { fired: false };

  if (!meetsThreshold(direction, ctx.todaysChangePct, pct)) return { fired: false };

  // referencePrice = currentPrice / (1 + pct/100). Numerically equivalent
  // to "previous close" without a separate query. Rounded to 4 decimals
  // for the audit row; the push body uses fewer.
  const prevClose = ctx.currentPrice / (1 + ctx.todaysChangePct / 100);
  return {
    fired: true,
    referencePrice: Number(prevClose.toFixed(4)),
    movePct: ctx.todaysChangePct,
    context: {
      type: "price_move_1d",
      direction,
      threshold_pct: pct,
      polygon_todays_change_pct: ctx.todaysChangePct,
    },
  };
};

// ============================================================
// price_move_nd — N business days cumulative change
// ============================================================
//
// Reference = stock_price.close at the business date N days before today.
// We resolve "N business days ago" via the `business_dates` table — the
// canonical trading calendar already used by iOS and the Python pipeline.
//
// Two queries per fired alert (one for the date, one for the close). Both
// are indexed; combined cost is a few ms. /tick batches these naturally
// because evaluators run sequentially per alert, but if this becomes a hot
// path we can precompute reference prices once per tick keyed by (ticker,
// days) and pass them in via EvalContext.

const evalPriceMoveNd: Evaluator = async (ticker, condition, ctx) => {
  const direction = condition.direction as string;
  const pct       = condition.pct as number | undefined;
  const days      = condition.days as number | undefined;
  if (typeof pct !== "number"  || !Number.isFinite(pct))  return { fired: false };
  if (typeof days !== "number" || !Number.isFinite(days) || days < 1) return { fired: false };

  // Step 1: resolve the business date N days before today.
  const { data: bdRows, error: bdErr } = await admin()
    .from("business_dates")
    .select("business_date")
    .eq("calendar_code", "US")
    .lt("business_date", ctx.todayBusinessDate)
    .order("business_date", { ascending: false })
    .limit(1)
    .range(days - 1, days - 1);  // 0-indexed OFFSET (N-1)

  if (bdErr) {
    console.error(`[evalPriceMoveNd] business_dates lookup failed for ${ticker}:`, bdErr);
    return { fired: false };
  }
  const refDate = bdRows?.[0]?.business_date as string | undefined;
  if (!refDate) {
    // Not enough history in business_dates. Skip rather than fire.
    return { fired: false };
  }

  // Step 2: pull the close on that date.
  const { data: priceRows, error: priceErr } = await admin()
    .from("stock_price")
    .select("close")
    .eq("ticker", ticker)
    .eq("business_date", refDate)
    .maybeSingle();

  if (priceErr) {
    console.error(`[evalPriceMoveNd] stock_price lookup failed for ${ticker} ${refDate}:`, priceErr);
    return { fired: false };
  }
  const refPrice = priceRows?.close as number | undefined;
  if (!refPrice || refPrice <= 0) return { fired: false };

  const movePct = ((ctx.currentPrice - refPrice) / refPrice) * 100;
  if (!meetsThreshold(direction, movePct, pct)) return { fired: false };

  return {
    fired: true,
    referencePrice: refPrice,
    movePct: Number(movePct.toFixed(4)),
    context: {
      type: "price_move_nd",
      direction,
      threshold_pct: pct,
      days,
      reference_business_date: refDate,
      current_price: ctx.currentPrice,
    },
  };
};

// ============================================================
// The registry — adding an alert type is ONE line here
// ============================================================

export const evaluators: Record<string, Evaluator> = {
  "price_move_1d": evalPriceMove1d,
  "price_move_nd": evalPriceMoveNd,
  // future:
  //   "realized_vol_20d": evalRealizedVol20d,
  //   "ma_cross_50_200":  evalMaCross,
  //   "earnings_window":  evalEarningsWindow,
  //   "and":              evalAnd,   // compose existing types
};
