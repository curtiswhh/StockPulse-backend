-- 111_users_quiet_hours.sql
-- Server-side quiet hours, following the push_enabled pattern (110).
--
-- Migration 015 dropped the original quiet_hours_start/end columns and
-- deferred the feature. This re-adds them plus an explicit enabled flag:
--   - iOS PATCHes all three (and users.timezone, so the window is
--     evaluated in the user's local time) when the Settings controls
--     change. Existing "users update own row" RLS policy covers it.
--   - /dispatch drops non-critical notifications whose user is inside
--     their quiet window, reason 'quiet_hours'. is_critical bypasses,
--     matching daily_cap behavior. Dropped, not held — a stale price
--     alert delivered hours later is worse than no alert.
--
-- time (not timestamptz): wall-clock in the user's timezone, window may
-- cross midnight (default 22:00–07:00). Defaults match the iOS defaults;
-- enabled defaults false so existing users are unaffected.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS quiet_hours_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS quiet_hours_start   time    NOT NULL DEFAULT '22:00',
  ADD COLUMN IF NOT EXISTS quiet_hours_end     time    NOT NULL DEFAULT '07:00';

COMMENT ON COLUMN users.quiet_hours_enabled IS
  'User-level quiet hours opt-in. Set from iOS Settings. /dispatch drops non-critical notifications inside the window.';
COMMENT ON COLUMN users.quiet_hours_start IS
  'Quiet window start, wall-clock in users.timezone. Window may cross midnight.';
COMMENT ON COLUMN users.quiet_hours_end IS
  'Quiet window end, wall-clock in users.timezone.';
