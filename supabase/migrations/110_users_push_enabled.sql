-- 110_users_push_enabled.sql
-- Explicit user opt-in/out flag for push notifications.
--
-- Until now the only opt-out signal was apns_token IS NULL, which conflates
-- "user turned pushes off" with "token expired / cleared by dispatch".
-- push_enabled separates intent from delivery address:
--   - iOS PATCHes this when the Settings toggle changes (existing
--     "users update own row" RLS policy covers it).
--   - /dispatch drops pending notifications for users with
--     push_enabled = false, before even looking at the token.
--
-- Default true: existing users keep receiving pushes unchanged.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS push_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN users.push_enabled IS
  'User-level push opt-in. Set from the iOS Settings toggle. /dispatch drops all notifications when false.';
