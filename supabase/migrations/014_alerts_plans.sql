-- 014_alerts_plans.sql
-- Phase 7a — Server-side push alerts.
--
-- Subscription-tier definitions for the alerts feature. JSONB `limits` is
-- intentionally schema-free: adding a new constraint (e.g. allowed_tickers,
-- max_critical_alerts) means one column update on this row, not a migration.
--
-- The DB trigger in 017_alerts_tier_enforcement.sql reads these limits at
-- alert insert/update time and rejects rows that violate the user's plan.
-- iOS reads the same limits for greying-out UI, so the source of truth is
-- this table.
--
-- Limits seeded here mirror the iOS SubscriptionTier enum (AppState.swift):
--   - free.minCooldownMinutes  = 60   → min_cooldown_s  = 3600
--   - pro.minCooldownMinutes   = 5    → min_cooldown_s  = 300
--   - free.maxWatchlistSize    = 5    → max_alerts      = 5
--   - pro.maxWatchlistSize     = ∞    → max_alerts      = null
-- If you change one side, change the other in the same PR.

CREATE TABLE IF NOT EXISTS plans (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL UNIQUE,
  display_name  text        NOT NULL,
  limits        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Seed: free + pro. Idempotent on `name`.
INSERT INTO plans (name, display_name, limits) VALUES
  ('free', 'Free', jsonb_build_object(
    'max_alerts',               5,
    'allowed_condition_types',  jsonb_build_array('price_move_1d', 'price_move_nd'),
    'min_cooldown_s',           3600,
    'max_n_days',               10
  )),
  ('pro', 'Pro', jsonb_build_object(
    'max_alerts',               null,
    'allowed_condition_types',  jsonb_build_array('price_move_1d', 'price_move_nd'),
    'min_cooldown_s',           300,
    'max_n_days',               10
  ))
ON CONFLICT (name) DO NOTHING;

-- Plans are public — the iOS UI reads `limits` to render tier-aware controls
-- (e.g. "Pro: cooldown can go as low as 5 min"). No user data lives here, so
-- we expose it via RLS rather than RPC.
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "plans are public" ON plans
  FOR SELECT
  TO authenticated, anon
  USING (true);

COMMENT ON TABLE  plans IS
  'Subscription tier definitions for server-side alerts. JSONB limits enforced by the alerts_plan_check trigger.';
COMMENT ON COLUMN plans.limits IS
  'JSONB limits: max_alerts (int|null), allowed_condition_types (string[]), min_cooldown_s (int), max_n_days (int). Add new constraints here without a migration.';
