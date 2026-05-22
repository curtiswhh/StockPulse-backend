-- 101_alerts_var_support.sql
-- MVP — Add price_move_var to the allowed condition types on every plan.
--
-- The check_alert_against_plan() trigger from 017 reads allowed_condition_types
-- from plans.limits. Adding "price_move_var" to that array makes the
-- existing trigger accept the new condition type without code changes.
--
-- New condition shape (handled by /tick's evaluator registry):
--   {
--     "type":       "price_move_var",
--     "direction":  "up" | "down" | "any",
--     "confidence": 0.90 | 0.95 | 0.99,
--     "lookback":   60 | 120 | 252            -- optional, default 252
--   }
--
-- Threshold is computed server-side inside /tick from historical-simulation
-- VaR on the last `lookback` days of stock_price closes. No new tables —
-- see supabase/functions/_shared/var_precompute.ts.

UPDATE plans
SET limits = jsonb_set(
  limits,
  '{allowed_condition_types}',
  CASE
    WHEN limits->'allowed_condition_types' ? 'price_move_var'
      THEN limits->'allowed_condition_types'
    ELSE (limits->'allowed_condition_types') || '"price_move_var"'::jsonb
  END
)
WHERE name IN ('free', 'pro');

-- Verify (run manually):
--   SELECT name, limits->'allowed_condition_types' FROM plans;
--   Expect: ["price_move_1d","price_move_nd","price_move_var"]
