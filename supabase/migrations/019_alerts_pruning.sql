-- 019_alerts_pruning.sql
-- Phase 7a — Server-side push alerts.
--
-- Nightly prune of price_snapshots older than 14 days. The function is
-- defined here; the pg_cron schedule that calls it is set up in PR 2
-- alongside the /tick cron, so that the cron jobs are co-located in one
-- migration and easier to audit/disable as a group.
--
-- 14 days is the retention window because:
--   · plans.limits.max_n_days = 10 business days
--   · 10 business days × 7/5 ≈ 14 calendar days for weekend padding
--   · evaluators read price history with `WHERE ts >= now() - interval`,
--     so anything older than the longest condition window is dead weight.
--
-- If max_n_days changes, also revisit the interval below.

CREATE OR REPLACE FUNCTION prune_old_price_snapshots()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  DELETE FROM price_snapshots
  WHERE ts < now() - interval '14 days';
END;
$$;

COMMENT ON FUNCTION prune_old_price_snapshots IS
  'Deletes price_snapshots older than 14 days. Wired to pg_cron in the PR 2 cron migration.';
