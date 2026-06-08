-- 109_alerts_cooldown_10d.sql
-- Raise the alerts cooldown ceiling from 1 day (86400s) to 10 days (864000s)
-- so users can space fires across multiple days. The lower bound (60s) and the
-- per-plan min_cooldown_s floor in check_alert_against_plan() are unchanged —
-- the floor still gates the low end per tier, the CHECK only guards the extremes.

ALTER TABLE user_alerts DROP CONSTRAINT IF EXISTS alerts_cooldown_sane;

ALTER TABLE user_alerts
  ADD CONSTRAINT alerts_cooldown_sane
  CHECK (cooldown_s BETWEEN 60 AND 864000);
