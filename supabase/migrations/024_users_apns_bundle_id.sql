-- 024_users_apns_bundle_id.sql
-- Per-device APNs topic. StockPulse and StockPulseLite share this backend
-- but have different bundle IDs; APNs requires apns-topic == the token's
-- bundle ID. Each app sends its own bundle ID at registration. NULL means
-- "use the APNS_BUNDLE_ID env default" so existing StockPulse rows are
-- unaffected.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS apns_bundle_id text;

COMMENT ON COLUMN users.apns_bundle_id IS
  'Bundle ID the current apns_token belongs to. Used as the APNs topic. NULL falls back to APNS_BUNDLE_ID env.';
