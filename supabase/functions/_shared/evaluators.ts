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
//   `pct`. Reference price comes from the cached daily bars
//   (`polygon_aggregate_cache`) at the resolved business date (N business
//   days before today, looked up via `business_dates`).
//
// Direction semantics (both types):
//   "up"   → fires when actual_pct >= +abs(pct)
//   "down" → fires when actual_pct <= -abs(pct)
//   "any"  → fires when |actual_pct| >= abs(pct)
// ────────────────────────────────────────────────────────────────────────

import { admin } from "./supabase_admin.ts";
import { warmAggregateCache } from "./quote_fusion.ts";

const WARM_DAYS = 365;

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
  /// Trading date of the reference price (YYYY-MM-DD), for the push body.
  referenceDate?: string;
  /// How many business days back the reference price is.
  referenceDaysAgo?: number;
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
  if (direction === "up") return actualPct >= t;
  if (direction === "down") return actualPct <= -t;
  if (direction === "any") return Math.abs(actualPct) >= t;
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

const evalPriceMove1d: Evaluator = async (ticker, condition, ctx) => {
  const direction = condition.direction as string;
  const pct = condition.pct as number | undefined;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return { fired: false };
  if (ctx.todaysChangePct === null) return { fired: false };

  if (!meetsThreshold(direction, ctx.todaysChangePct, pct)) return { fired: false };

  // Reference = the actual prior-day close from the cached daily bars. Warm
  // the cache on a miss, then fall back to the snapshot-derived close so the
  // alert still fires if the bar is genuinely unavailable.
  const refDate = await businessDateNDaysAgo(ctx.todayBusinessDate, 1);
  const derivedClose = ctx.currentPrice / (1 + ctx.todaysChangePct / 100);
  let prevClose = refDate ? await cachedCloseOnDate(ticker, refDate) : undefined;
  if (!prevClose || prevClose <= 0) {
    await warmAggregateCache([ticker], WARM_DAYS);
    prevClose = refDate ? await cachedCloseOnDate(ticker, refDate) : undefined;
  }
  if (!prevClose || prevClose <= 0) prevClose = derivedClose;

  return {
    fired: true,
    referencePrice: Number(prevClose.toFixed(4)),
    movePct: ctx.todaysChangePct,
    referenceDate: refDate,
    referenceDaysAgo: 1,
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
// Reference = the cached daily close at the business date N days before
// today. We resolve "N business days ago" via the `business_dates` table —
// the canonical trading calendar already used by iOS and the Python pipeline.
//
// Two queries per fired alert (one for the date, one for the close). Both
// are indexed; combined cost is a few ms. /tick batches these naturally
// because evaluators run sequentially per alert, but if this becomes a hot
// path we can precompute reference prices once per tick keyed by (ticker,
// days) and pass them in via EvalContext.

const evalPriceMoveNd: Evaluator = async (ticker, condition, ctx) => {
  const direction = condition.direction as string;
  const pct = condition.pct as number | undefined;
  const days = condition.days as number | undefined;
  if (typeof pct !== "number" || !Number.isFinite(pct)) return { fired: false };
  if (typeof days !== "number" || !Number.isFinite(days) || days < 1) return { fired: false };

  // Step 1: resolve the business date N days before today.
  const refDate = await businessDateNDaysAgo(ctx.todayBusinessDate, days);
  if (!refDate) {
    // Not enough history in business_dates. Skip rather than fire.
    return { fired: false };
  }

  // Step 2: pull the close on that date from the cached daily bars. On a
  // miss (e.g. a freshly-added alert whose ticker was never cached), warm
  // it on the spot and retry once, so the alert is live the same minute.
  let refPrice = await cachedCloseOnDate(ticker, refDate);
  if (!refPrice || refPrice <= 0) {
    await warmAggregateCache([ticker], WARM_DAYS);
    refPrice = await cachedCloseOnDate(ticker, refDate);
  }
  if (!refPrice || refPrice <= 0) return { fired: false };

  const movePct = ((ctx.currentPrice - refPrice) / refPrice) * 100;
  if (!meetsThreshold(direction, movePct, pct)) return { fired: false };

  return {
    fired: true,
    referencePrice: refPrice,
    movePct: Number(movePct.toFixed(4)),
    referenceDate: refDate,
    referenceDaysAgo: days,
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

/// Resolve the US business date `n` trading days before `today` (YYYY-MM-DD).
async function businessDateNDaysAgo(today: string, n: number): Promise<string | undefined> {
  const { data, error } = await admin()
    .from("business_dates")
    .select("business_date")
    .eq("calendar_code", "US")
    .lt("business_date", today)
    .order("business_date", { ascending: false })
    .range(n - 1, n - 1);  // 0-indexed OFFSET (N-1)
  if (error) {
    console.error(`[businessDateNDaysAgo] lookup failed:`, error);
    return undefined;
  }
  return data?.[0]?.business_date as string | undefined;
}

/// Reference close on a business date for any ticker, read from the cached
/// daily bars. Matches the bar whose NY business date equals refDate.
async function cachedCloseOnDate(ticker: string, refDate: string): Promise<number | undefined> {
  const { data, error } = await admin()
    .from("polygon_aggregate_cache")
    .select("bars")
    .eq("ticker", ticker)
    .eq("adjusted", true)
    .maybeSingle();
  if (error) {
    console.error(`[evalPriceMoveNd] aggregate_cache lookup failed for ${ticker}:`, error);
    return undefined;
  }
  const bars = (data?.bars ?? []) as { c: number; t: number }[];
  const match = bars.find((b) => businessDateNY(b.t) === refDate);
  return match?.c;
}

/// Convert an aggregate bar's epoch-ms timestamp to YYYY-MM-DD in NY.
function businessDateNY(ms: number): string {
  if (!ms || ms <= 0) return "";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(ms));
}

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