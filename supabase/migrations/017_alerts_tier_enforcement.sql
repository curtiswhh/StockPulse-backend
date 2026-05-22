-- 017_alerts_tier_enforcement.sql
-- Phase 7a — Server-side push alerts.
--
-- Validates inserts/updates on `alerts` against the user's plan limits.
--
-- StockPulse-specific note: tier is stored as `users.subscription_tier`
-- (text), and joined to `plans.name`. We DO NOT have a uuid FK from users
-- to plans — the text column is the source of truth coming from the iOS
-- client today, and the RevenueCat webhook in a later PR. If the joined
-- plan can't be resolved (NULL subscription_tier, typo, or a tier name
-- that doesn't exist in plans), we fall back to the free plan's limits.
-- That's the safest failure mode: a user with an unrecognized tier is
-- gated the most conservatively, not given the loosest limits.

CREATE OR REPLACE FUNCTION check_alert_against_plan()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  user_limits   jsonb;
  allowed_types jsonb;
  min_cooldown  int;
  max_alerts    int;
  max_n_days    int;
  current_count int;
  cond_type     text;
  cond_days     int;
BEGIN
  -- 1. Resolve the user's plan via users.subscription_tier → plans.name.
  --    If the user has no row in `users` yet (shouldn't happen post-PR 4,
  --    but defensive), OR if subscription_tier is NULL/unknown, fall back
  --    to the free plan's limits.
  SELECT p.limits INTO user_limits
  FROM   users u
  JOIN   plans p ON p.name = u.subscription_tier
  WHERE  u.id = NEW.user_id;

  IF user_limits IS NULL THEN
    SELECT limits INTO user_limits FROM plans WHERE name = 'free';
    IF user_limits IS NULL THEN
      RAISE EXCEPTION 'no free plan seeded — check 014_alerts_plans.sql';
    END IF;
  END IF;

  -- 2. Condition type allowed?
  cond_type     := NEW.condition->>'type';
  allowed_types := user_limits->'allowed_condition_types';
  IF allowed_types IS NOT NULL AND NOT (allowed_types ? cond_type) THEN
    RAISE EXCEPTION 'plan does not allow condition type: %', cond_type
      USING ERRCODE = 'check_violation';
  END IF;

  -- 3. Cooldown above the plan's floor?
  min_cooldown := (user_limits->>'min_cooldown_s')::int;
  IF min_cooldown IS NOT NULL AND NEW.cooldown_s < min_cooldown THEN
    RAISE EXCEPTION 'cooldown too short for plan: % < %', NEW.cooldown_s, min_cooldown
      USING ERRCODE = 'check_violation';
  END IF;

  -- 4. For price_move_nd, the `days` field must be within the plan's max.
  --    Other condition types ignore this check.
  IF cond_type = 'price_move_nd' THEN
    cond_days := (NEW.condition->>'days')::int;
    max_n_days := (user_limits->>'max_n_days')::int;
    IF cond_days IS NULL OR cond_days < 1 THEN
      RAISE EXCEPTION 'price_move_nd condition must include a positive `days` field'
        USING ERRCODE = 'check_violation';
    END IF;
    IF max_n_days IS NOT NULL AND cond_days > max_n_days THEN
      RAISE EXCEPTION 'days too large for plan: % > %', cond_days, max_n_days
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- 5. Alert-count quota. Only checked on INSERT (new enabled row) and on
  --    UPDATE when enabled flips from false → true. UPDATEs that don't
  --    change `enabled` are exempt — bumping cooldown_s on an existing
  --    row shouldn't re-trigger the quota check.
  max_alerts := (user_limits->>'max_alerts')::int;
  IF max_alerts IS NOT NULL THEN
    IF TG_OP = 'INSERT' AND NEW.enabled THEN
      SELECT count(*) INTO current_count
      FROM alerts
      WHERE user_id = NEW.user_id AND enabled = true;
      IF current_count >= max_alerts THEN
        RAISE EXCEPTION 'alert quota exceeded for plan: % >= %', current_count, max_alerts
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF TG_OP = 'UPDATE' AND NEW.enabled AND NOT OLD.enabled THEN
      SELECT count(*) INTO current_count
      FROM alerts
      WHERE user_id = NEW.user_id AND enabled = true AND id <> NEW.id;
      IF current_count >= max_alerts THEN
        RAISE EXCEPTION 'alert quota exceeded for plan: % >= %', current_count, max_alerts
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS alerts_plan_check ON alerts;
CREATE TRIGGER alerts_plan_check
  BEFORE INSERT OR UPDATE ON alerts
  FOR EACH ROW EXECUTE FUNCTION check_alert_against_plan();

COMMENT ON FUNCTION check_alert_against_plan IS
  'Enforces plans.limits on alert insert/update. Joins users.subscription_tier to plans.name; falls back to free if unresolved.';
