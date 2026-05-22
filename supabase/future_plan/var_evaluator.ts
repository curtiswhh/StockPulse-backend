// _shared/var_evaluator.ts
// MVP — Evaluator for price_move_var alerts.
//
// Reads precomputed thresholds from EvalContext.varThresholds, which /tick
// fills in via var_precompute.ts. The evaluator itself is O(1) — no
// database access at evaluation time.

import type { Evaluator } from "./evaluators.ts";

/// Add to your EvalContext interface in evaluators.ts:
///   varThresholds?: Map<string, {
///     var_pct_lower: number;
///     var_pct_upper: number;
///     n_samples: number;
///     as_of_business_date: string;
///   }>;

export const evalPriceMoveVar: Evaluator = async (ticker, condition, ctx) => {
  const direction  = condition.direction as string;
  const confidence = condition.confidence as number | undefined;
  const lookback   = (condition.lookback as number | undefined) ?? 252;

  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return { fired: false };
  }
  if (ctx.todaysChangePct === null || ctx.todaysChangePct === undefined) {
    return { fired: false };
  }
  // deno-lint-ignore no-explicit-any
  const thresholds = (ctx as any).varThresholds as Map<string, {
    var_pct_lower: number;
    var_pct_upper: number;
    n_samples: number;
    as_of_business_date: string;
  }> | undefined;

  if (!thresholds) return { fired: false };
  const key = `${ticker}|${confidence}|${lookback}`;
  const t = thresholds.get(key);
  if (!t) return { fired: false };

  const today = ctx.todaysChangePct;
  let fired = false;
  if (direction === "down") fired = today <= t.var_pct_lower;
  else if (direction === "up") fired = today >= t.var_pct_upper;
  else if (direction === "any") fired = today <= t.var_pct_lower || today >= t.var_pct_upper;

  if (!fired) return { fired: false };

  return {
    fired: true,
    referencePrice: ctx.currentPrice / (1 + today / 100),
    movePct: today,
    context: {
      type: "price_move_var",
      direction,
      confidence,
      lookback,
      var_pct_lower: t.var_pct_lower,
      var_pct_upper: t.var_pct_upper,
      n_samples: t.n_samples,
      var_as_of_business_date: t.as_of_business_date,
    },
  };
};
