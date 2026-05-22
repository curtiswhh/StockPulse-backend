-- 100_watchlists_table.sql
-- MVP — Cross-device watchlist sync.
--
-- Each row is one (user, ticker) pair in some named group. SwiftData on
-- the device caches these rows; this table is the source of truth for
-- cross-device merge.
--
-- Conflict resolution: client_updated_at is set by iOS on every write.
-- A new device reading the table accepts the row as-is; future iOS
-- writes overwrite with the newer timestamp.
--
-- Soft-delete: deleted_at being non-null means the row is removed but
-- still on disk so reinstalled clients don't resurrect it.

CREATE TABLE IF NOT EXISTS watchlists (
  id                 uuid        PRIMARY KEY,                            -- client-generated
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  ticker             text        NOT NULL,
  company_name       text        NOT NULL,
  group_name         text        NOT NULL DEFAULT 'My Watchlist',
  sort_order         int         NOT NULL DEFAULT 0,
  added_at           timestamptz NOT NULL DEFAULT now(),
  client_updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

-- Hot path for "give me my watchlist".
CREATE INDEX IF NOT EXISTS watchlists_user_active_idx
  ON watchlists (user_id, sort_order)
  WHERE deleted_at IS NULL;

-- One live row per (user, ticker). Partial so a soft-deleted row doesn't
-- block re-adding the same ticker later. Also serves as the hot path for
-- "is this user already watching this ticker?" and is the conflict target
-- for iOS upserts.
CREATE UNIQUE INDEX IF NOT EXISTS watchlists_user_ticker_idx
  ON watchlists (user_id, ticker)
  WHERE deleted_at IS NULL;

-- RLS — every row scoped to its owner.
ALTER TABLE watchlists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage own watchlists" ON watchlists
  FOR ALL
  TO authenticated
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE watchlists IS
  'Cross-device watchlist sync. SwiftData on iOS is the write-through cache; this table is the source of truth.';
COMMENT ON COLUMN watchlists.client_updated_at IS
  'Last write timestamp from iOS. Used for last-write-wins conflict resolution.';
COMMENT ON COLUMN watchlists.deleted_at IS
  'Soft-delete marker. Non-null = removed. Prevents reinstalled clients from resurrecting deleted rows.';
  