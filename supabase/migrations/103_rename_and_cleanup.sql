-- 103_rename_and_cleanup.sql
-- Backend table cleanup: prefix tables by domain and drop unused legacy tables.
--
--   Polygon caches : quote_cache, aggregate_cache, price_snapshots
--                      -> polygon_quote_cache, polygon_aggregate_cache, polygon_price_snapshots
--   User-owned     : alerts, alert_fires, notifications, plans, watchlists
--                      -> user_alerts, user_alert_fires, user_notifications, user_plans, user_watchlists
--   Stock metadata : earnings_calendar, sp500_constituents
--                      -> stock_earnings_calendar, stock_sp500_constituents
--   Dropped        : alert_events, watchlist_stocks (blank, no live readers)
--
-- RENAME keeps all data, indexes, RLS policies, FKs and grants intact.
-- Idempotent guards let this run safely against a partially-migrated DB.

BEGIN;

-- ── Drop unused legacy tables ────────────────────────────────
DROP TABLE IF EXISTS alert_events     CASCADE;
DROP TABLE IF EXISTS watchlist_stocks CASCADE;

-- ── Polygon caches ───────────────────────────────────────────
ALTER TABLE IF EXISTS quote_cache       RENAME TO polygon_quote_cache;
ALTER TABLE IF EXISTS aggregate_cache   RENAME TO polygon_aggregate_cache;
ALTER TABLE IF EXISTS price_snapshots   RENAME TO polygon_price_snapshots;

-- ── User-owned tables ────────────────────────────────────────
ALTER TABLE IF EXISTS alerts        RENAME TO user_alerts;
ALTER TABLE IF EXISTS alert_fires   RENAME TO user_alert_fires;
ALTER TABLE IF EXISTS notifications RENAME TO user_notifications;
ALTER TABLE IF EXISTS plans         RENAME TO user_plans;
ALTER TABLE IF EXISTS watchlists    RENAME TO user_watchlists;

-- ── Stock metadata tables ────────────────────────────────────
ALTER TABLE IF EXISTS earnings_calendar    RENAME TO stock_earnings_calendar;
ALTER TABLE IF EXISTS sp500_constituents   RENAME TO stock_sp500_constituents;

-- ── Rebind functions/triggers whose bodies name the old tables ───
-- RENAME updates FKs, indexes, RLS and grants automatically, but plpgsql/SQL
-- function bodies resolve table names at call time, so they must be replaced.

-- search_sp500 (008 shape) → stock_sp500_constituents
CREATE OR REPLACE FUNCTION search_sp500(p_query TEXT, p_limit INT DEFAULT 15)
RETURNS TABLE (
    ticker          TEXT,
    company_name    TEXT,
    sector          TEXT,
    sub_industry    TEXT,
    is_active       BOOLEAN,
    calendar_code   TEXT
)
LANGUAGE SQL STABLE AS $$
    SELECT s.ticker, s.company_name, s.sector, s.sub_industry, s.is_active, s.calendar_code
    FROM stock_sp500_constituents s
    WHERE s.ticker ILIKE (p_query || '%')
       OR s.company_name ILIKE ('%' || p_query || '%')
    ORDER BY
        CASE WHEN UPPER(s.ticker) = UPPER(p_query) THEN 0
             WHEN s.ticker ILIKE (p_query || '%') THEN 1
             ELSE 2 END,
        s.ticker ASC
    LIMIT p_limit;
$$;
GRANT EXECUTE ON FUNCTION search_sp500(TEXT, INT) TO anon, authenticated;

-- prune_old_price_snapshots → polygon_price_snapshots
CREATE OR REPLACE FUNCTION prune_old_price_snapshots()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  DELETE FROM polygon_price_snapshots
  WHERE ts < now() - interval '14 days';
END;
$$;

-- check_alert_against_plan → user_plans / user_alerts (body references only)
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
  SELECT p.limits INTO user_limits
  FROM   users u
  JOIN   user_plans p ON p.name = u.subscription_tier
  WHERE  u.id = NEW.user_id;

  IF user_limits IS NULL THEN
    SELECT limits INTO user_limits FROM user_plans WHERE name = 'free';
    IF user_limits IS NULL THEN
      RAISE EXCEPTION 'no free plan seeded — check 014_alerts_plans.sql';
    END IF;
  END IF;

  cond_type     := NEW.condition->>'type';
  allowed_types := user_limits->'allowed_condition_types';
  IF allowed_types IS NOT NULL AND NOT (allowed_types ? cond_type) THEN
    RAISE EXCEPTION 'plan does not allow condition type: %', cond_type
      USING ERRCODE = 'check_violation';
  END IF;

  min_cooldown := (user_limits->>'min_cooldown_s')::int;
  IF min_cooldown IS NOT NULL AND NEW.cooldown_s < min_cooldown THEN
    RAISE EXCEPTION 'cooldown too short for plan: % < %', NEW.cooldown_s, min_cooldown
      USING ERRCODE = 'check_violation';
  END IF;

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

  max_alerts := (user_limits->>'max_alerts')::int;
  IF max_alerts IS NOT NULL THEN
    IF TG_OP = 'INSERT' AND NEW.enabled THEN
      SELECT count(*) INTO current_count
      FROM user_alerts
      WHERE user_id = NEW.user_id AND enabled = true;
      IF current_count >= max_alerts THEN
        RAISE EXCEPTION 'alert quota exceeded for plan: % >= %', current_count, max_alerts
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF TG_OP = 'UPDATE' AND NEW.enabled AND NOT OLD.enabled THEN
      SELECT count(*) INTO current_count
      FROM user_alerts
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

-- Trigger moved with the table on rename; recreate to be explicit.
DROP TRIGGER IF EXISTS alerts_plan_check ON user_alerts;
CREATE TRIGGER alerts_plan_check
  BEFORE INSERT OR UPDATE ON user_alerts
  FOR EACH ROW EXECUTE FUNCTION check_alert_against_plan();

COMMIT;
