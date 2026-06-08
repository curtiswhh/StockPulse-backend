-- 108_pro_max_n_days_30.sql
-- Raise Pro's N-day alert lookback from 10 to 30 business days. Free stays 10.
--
-- Post-103 names: table is user_plans (was plans), snapshots are
-- polygon_price_snapshots (was price_snapshots). The enforcement trigger reads
-- max_n_days at insert/update time, so no trigger change is needed.
--
-- Retention coupling: prune_old_price_snapshots() keeps 14 calendar days —
-- enough for 10 business days, NOT 30 (~42+ calendar days with weekends/
-- holidays). We widen the prune window to 60d so the N-day evaluator keeps
-- its older anchor snapshot.

UPDATE user_plans
SET limits = jsonb_set(limits, '{max_n_days}', '30'::jsonb)
WHERE name = 'pro';

CREATE OR REPLACE FUNCTION public.prune_old_price_snapshots()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  DELETE FROM polygon_price_snapshots
  WHERE ts < now() - interval '60 days';
END;
$function$;

COMMENT ON FUNCTION public.prune_old_price_snapshots IS
  'Deletes polygon_price_snapshots older than 60 days. Widened from 14d to cover Pro max_n_days=30 business-day anchors.';