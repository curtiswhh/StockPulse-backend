-- 015_alerts_user_columns.sql
-- Phase 7a — Server-side push alerts.
--
-- Extends the existing `public.users` table with the minimum surface the
-- alerts feature needs. We DO NOT create a separate user_alert_prefs table —
-- the alerts feature shares the existing one-row-per-user surface.
--
-- Existing columns reused as-is:
--   apns_token         → /dispatch reads this for push delivery
--   subscription_tier  → text-keyed lookup into plans.name (see 017)
--
-- Existing columns REMOVED (quiet hours deferred entirely; if we ever ship
-- them, they're added back via a new migration):
--   quiet_hours_start, quiet_hours_end
--
-- New columns added here (NOT NULL with defaults, safe on a populated
-- table — no backfill needed):
--   timezone     IANA tz. Useful for stamping fire times in the user's
--                local time in iOS UI and push body. Cheap default 'UTC'.
--   daily_cap    Max push notifications per UTC day. PR 3 will respect
--                this as the "drop everything past N" anti-spam gate.
--   updated_at   Touched by a trigger; useful for diagnostics.
--
-- Deliberately NOT adding: quiet_enabled, bundle_window_s, digest_at,
-- cap_behavior. These come back when (and if) PR 6 ships bundling/digest.

-- ============================================================
-- Drop the existing quiet-hours columns
-- ============================================================

ALTER TABLE users
  DROP COLUMN IF EXISTS quiet_hours_start,
  DROP COLUMN IF EXISTS quiet_hours_end;

-- ============================================================
-- Add the new columns. IF NOT EXISTS so re-running is safe.
-- ============================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS timezone   text        NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS daily_cap  int         NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- subscription_tier must match one of the rows in plans.name. We don't add
-- a real FK because plans.id is uuid while users.subscription_tier is text;
-- a CHECK against a hardcoded list would force a migration every time we
-- add a tier. Instead, the trigger in 017 falls back to free-plan limits if
-- subscription_tier doesn't resolve, which is the safest failure mode.

-- ============================================================
-- updated_at touch trigger
-- ============================================================

CREATE OR REPLACE FUNCTION users_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_touch ON users;
CREATE TRIGGER users_touch
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_touch_updated_at();

-- ============================================================
-- Index for /dispatch's "users with a push token" scan
-- ============================================================

CREATE INDEX IF NOT EXISTS users_apns_token_idx
  ON users (id)
  WHERE apns_token IS NOT NULL;

-- ============================================================
-- RLS — the existing users table may or may not already have policies.
-- Make sure the ones the alerts feature needs are present.
-- ============================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own row" ON users;
CREATE POLICY "users read own row" ON users
  FOR SELECT
  TO authenticated
  USING (id = auth.uid());

DROP POLICY IF EXISTS "users update own row" ON users;
CREATE POLICY "users update own row" ON users
  FOR UPDATE
  TO authenticated
  USING      (id = auth.uid())
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "users insert own row" ON users;
CREATE POLICY "users insert own row" ON users
  FOR INSERT
  TO authenticated
  WITH CHECK (id = auth.uid());

-- ============================================================
-- Comments
-- ============================================================

COMMENT ON COLUMN users.timezone IS
  'IANA timezone string. Used by iOS / push body for local-time stamping.';
COMMENT ON COLUMN users.daily_cap IS
  'Max push notifications per UTC day. PR 3 enforces; over-limit notifications are dropped.';
COMMENT ON COLUMN users.subscription_tier IS
  'Tier name, joined to plans.name in the alerts_plan_check trigger. Falls back to free if unrecognized.';
