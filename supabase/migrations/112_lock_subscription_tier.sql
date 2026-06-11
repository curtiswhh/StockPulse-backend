-- 112_lock_subscription_tier.sql
-- Security fix: the "users update own row" RLS policy (015) gates WHICH rows
-- a client can touch, but not WHICH COLUMNS. Any authenticated user could
-- PATCH users?id=eq.<own-uid> {"subscription_tier":"pro"} via PostgREST and
-- self-upgrade for free. RLS and column grants are AND-ed, so we keep the
-- existing policies and add column-level privileges on top.
--
-- subscription_tier and daily_cap become server-controlled (service_role
-- only — i.e. the future billing webhook). id/email/created_at are also
-- excluded from UPDATE since the client never legitimately changes them.
-- Grant list reflects the post-111 schema: includes push_enabled (110) and
-- the quiet_hours_* columns re-added in 111, which iOS PATCHes from Settings.

REVOKE INSERT, UPDATE ON public.users FROM authenticated, anon;

GRANT UPDATE (
  display_name,
  default_confidence,
  default_horizon,
  default_method,
  timezone,
  push_enabled,
  quiet_hours_enabled,
  quiet_hours_start,
  quiet_hours_end,
  apns_token,
  apns_env,
  apns_bundle_id,
  updated_at
) ON public.users TO authenticated;

-- Rows are normally created by handle_new_user() (001). The "insert own row"
-- policy is kept as a defensive path, but without tier/cap columns.
GRANT INSERT (
  id,
  email,
  display_name,
  default_confidence,
  default_horizon,
  default_method,
  timezone,
  push_enabled,
  quiet_hours_enabled,
  quiet_hours_start,
  quiet_hours_end,
  apns_token,
  apns_env,
  apns_bundle_id
) ON public.users TO authenticated;

COMMENT ON COLUMN public.users.subscription_tier IS
  'Plan name (FK to user_plans.name). Writable by service_role only — set by the billing webhook, never the client.';
