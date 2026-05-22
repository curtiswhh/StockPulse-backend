-- 022_alerts_users_apns_env.sql
-- Phase 7a — Server-side push alerts.
--
-- Adds the apns_env column to users. APNs has two endpoints:
--   production = api.push.apple.com         (App Store builds, TF release)
--   sandbox    = api.sandbox.push.apple.com (Xcode debug builds, TF beta)
--
-- A device token from one CAN'T be used on the other — Apple returns
-- BadDeviceToken. So each token must know which env it came from. iOS
-- sets this at registration time (PR 4) based on the build configuration.
--
-- Default 'production' because that's what App Store builds (the vast
-- majority of installs once shipped) use. Dev builds override to 'sandbox'.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS apns_env text NOT NULL DEFAULT 'production';

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_apns_env_check;
ALTER TABLE users
  ADD CONSTRAINT users_apns_env_check
  CHECK (apns_env IN ('production', 'sandbox'));

COMMENT ON COLUMN users.apns_env IS
  'APNs environment for users.apns_token. ''production'' (App Store/TF release) or ''sandbox'' (debug/TF beta). Set by iOS at token-registration time.';
