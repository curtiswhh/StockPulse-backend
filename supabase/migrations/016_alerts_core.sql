-- 016_alerts_core.sql
-- Phase 7a — Server-side push alerts.
--
-- The three core tables for the alert lifecycle:
--
--   alerts          — the rule. JSONB `condition` with a `type` discriminator
--                     (price_move_1d | price_move_nd | <future>). Schema is
--                     extension-ready: a new alert type is one new evaluator
--                     function in _shared/evaluators.ts + one new string in
--                     plans.limits.allowed_condition_types. No migration.
--
--   alert_fires     — append-only history of every trigger. Used for:
--                       · iOS "last fired" UI on the alert row
--                       · the "fired N times in 30d" preview in PR 6
--                       · future outcome labeling (useful/noise) for tuning
--                     The row is the receipt; the user-facing push lives
--                     in `notifications` (next table).
--
--   notifications   — dispatch queue. Decouples evaluation latency from
--                     delivery latency: /tick stages rows here in ~2s; APNs
--                     send happens in /dispatch's own cadence and can fail
--                     and retry without re-running the evaluator.
--                     Also where bundling/digest will accumulate later
--                     (PR 6) — the `kind` enum and `parent_bundle_id` self-
--                     reference are wired now even though /dispatch in PR 3
--                     only emits kind='single'.
--
-- Index strategy mirrors pulsealert-backend, which has been load-tested at
-- this exact query shape. Partial indexes on the hot paths (enabled alerts,
-- pending notifications) keep the index small even as the tables grow.

-- ============================================================
-- alerts
-- ============================================================

CREATE TABLE IF NOT EXISTS alerts (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker         text        NOT NULL,
  condition      jsonb       NOT NULL,
  condition_v    int         NOT NULL DEFAULT 1,
  is_critical    boolean     NOT NULL DEFAULT false,
  cooldown_s     int         NOT NULL DEFAULT 3600,
  enabled        boolean     NOT NULL DEFAULT true,
  last_fired_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Hot path for /tick: "all enabled alerts, grouped by ticker, fan out to
-- evaluators". The partial WHERE clause keeps the index small — disabled
-- alerts shouldn't pay index-maintenance cost.
CREATE INDEX IF NOT EXISTS alerts_enabled_ticker_idx
  ON alerts (enabled, ticker)
  WHERE enabled = true;

-- For iOS's "my alerts" list query and for cascade behavior on user delete.
CREATE INDEX IF NOT EXISTS alerts_user_idx
  ON alerts (user_id);

-- Guards against pathological values that would either spam users or
-- effectively disable the cooldown gate. The DB trigger in
-- 017_alerts_tier_enforcement.sql layers the per-plan min_cooldown_s on top.
ALTER TABLE alerts
  ADD CONSTRAINT alerts_cooldown_sane
  CHECK (cooldown_s BETWEEN 60 AND 86400);

-- The condition jsonb must at minimum carry a `type` discriminator — the
-- evaluator registry keys off it. Without this, a bad client could write
-- {} and silently skip every evaluation pass.
ALTER TABLE alerts
  ADD CONSTRAINT alerts_condition_has_type
  CHECK (condition ? 'type');

COMMENT ON TABLE  alerts IS
  'The rule. JSONB condition is type-discriminated; new alert types are added without schema changes.';
COMMENT ON COLUMN alerts.condition IS
  'JSONB shape varies by condition.type. Versioned by condition_v so shape evolution doesn''t break old rows.';
COMMENT ON COLUMN alerts.condition_v IS
  'Bump when the JSONB shape for a given condition.type changes; evaluators branch on this.';
COMMENT ON COLUMN alerts.cooldown_s IS
  'Seconds between fires of the same alert. Enforced by /tick reading last_fired_at. DB trigger enforces per-plan floor.';

-- ============================================================
-- alert_fires
-- ============================================================

CREATE TABLE IF NOT EXISTS alert_fires (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id         uuid        NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  fired_at         timestamptz NOT NULL DEFAULT now(),
  trigger_price    numeric,
  reference_price  numeric,
  move_pct         numeric,
  context          jsonb,
  -- Forward declaration: bundle_id links a fire to its bundled-notification
  -- parent (PR 6). FK is added in 016_alerts_core.sql AFTER notifications
  -- exists, see bottom of this file.
  bundle_id        uuid,
  outcome          text        CHECK (outcome IS NULL OR outcome IN ('useful', 'noise'))
);

-- "Show me the last 30 days of fires for this alert" — covers iOS detail
-- view + the future preview ("this alert would have fired N times").
CREATE INDEX IF NOT EXISTS alert_fires_alert_idx
  ON alert_fires (alert_id, fired_at DESC);

COMMENT ON TABLE  alert_fires IS
  'Append-only history of alert triggers. One row per fire; the user-facing notification is in `notifications`.';
COMMENT ON COLUMN alert_fires.context IS
  'JSONB free-form context from the evaluator (window_sec, direction, etc.). Shape lives in evaluators.ts.';
COMMENT ON COLUMN alert_fires.outcome IS
  'Optional user feedback for tuning defaults. Written by a future feedback flow, not /tick.';

-- ============================================================
-- notifications
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind              text        NOT NULL CHECK (kind IN ('single', 'bundle', 'digest')),
  payload           jsonb       NOT NULL,
  status            text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'sent', 'dropped', 'bundled_into')),
  scheduled_for     timestamptz NOT NULL DEFAULT now(),
  sent_at           timestamptz,
  parent_bundle_id  uuid        REFERENCES notifications(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Hot path for /dispatch: "give me pending rows whose scheduled_for has
-- passed, oldest first". Partial WHERE keeps the index tiny — once a row
-- is sent/dropped/bundled it exits the index.
CREATE INDEX IF NOT EXISTS notifications_dispatch_idx
  ON notifications (status, scheduled_for)
  WHERE status = 'pending';

-- Hot path for the daily-cap query in /dispatch ("how many did we send
-- today for this user?"). Partial keeps it small.
CREATE INDEX IF NOT EXISTS notifications_user_sent_idx
  ON notifications (user_id, sent_at)
  WHERE status = 'sent';

-- And for iOS reading its own delivered-notifications feed.
CREATE INDEX IF NOT EXISTS notifications_user_idx
  ON notifications (user_id, created_at DESC);

-- Wire up the alert_fires.bundle_id FK now that notifications exists.
-- Kept separate from the CREATE TABLE because of the circular reference
-- ordering — alert_fires has to exist before /tick can reference it,
-- but bundle_id wants to point at notifications which doesn't exist yet.
ALTER TABLE alert_fires
  ADD CONSTRAINT alert_fires_bundle_fk
  FOREIGN KEY (bundle_id) REFERENCES notifications(id) ON DELETE SET NULL;

COMMENT ON TABLE  notifications IS
  'Dispatch queue. /tick writes status=pending; /dispatch drains and sets sent/dropped/bundled_into.';
COMMENT ON COLUMN notifications.kind IS
  'single = one alert one push; bundle = N alerts in one push; digest = morning sweep of deferred. PR 6 lights bundle/digest up.';
COMMENT ON COLUMN notifications.payload IS
  'JSONB push payload (ticker, move_pct, trigger_price, etc.) + child references for bundle/digest kinds.';
COMMENT ON COLUMN notifications.parent_bundle_id IS
  'When status=bundled_into, points at the parent bundle/digest row whose push subsumed this one.';

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE alerts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_fires   ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- alerts: full CRUD on own rows. The DB trigger in 017 layers the tier-limit
-- check on top of these policies.
CREATE POLICY "users manage own alerts" ON alerts
  FOR ALL
  TO authenticated
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- alert_fires: read-only for users (only /tick writes, via service_role).
-- The user owns a fire transitively through alert_id → alerts.user_id.
CREATE POLICY "users read own alert fires" ON alert_fires
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM alerts
      WHERE alerts.id = alert_fires.alert_id
        AND alerts.user_id = auth.uid()
    )
  );

-- notifications: read-only for users (only /tick and /dispatch write,
-- both via service_role).
CREATE POLICY "users read own notifications" ON notifications
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());
