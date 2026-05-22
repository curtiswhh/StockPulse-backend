-- 020_alerts_users_tier_fk.sql
-- Phase 7a — Server-side push alerts.
--
-- Adds a real foreign key from users.subscription_tier → plans.name. This
-- supersedes the "text-keyed join + free-plan fallback" approach in
-- 017_alerts_tier_enforcement.sql. The trigger's fallback branch is kept
-- as defense-in-depth (e.g. if an admin temporarily disables the FK), but
-- under normal operation the FK guarantees the join always resolves.
--
-- ON UPDATE CASCADE — renaming a plan (UPDATE plans SET name='premium'
--   WHERE name='pro') automatically propagates to every users row in the
--   same transaction. No app downtime, no out-of-sync window, no migration.
--
-- ON DELETE RESTRICT — can't drop a plan row that any user references.
--   Protects against the accidental "DELETE FROM plans WHERE name='pro'"
--   that would otherwise nuke every paid user's tier.
--
-- Pre-flight checks (run these first, see PR1 guide for instructions):
--   1. Every users.subscription_tier must resolve to a plans.name.
--   2. plans.name must already be UNIQUE (it is — see 014).
-- The FK creation will fail loudly if either is violated.

ALTER TABLE users
  ADD CONSTRAINT users_subscription_tier_fkey
  FOREIGN KEY (subscription_tier)
  REFERENCES plans(name)
  ON UPDATE CASCADE
  ON DELETE RESTRICT;

COMMENT ON CONSTRAINT users_subscription_tier_fkey ON users IS
  'Enforces subscription_tier matches a real plans.name. CASCADE on rename, RESTRICT on plan delete.';
