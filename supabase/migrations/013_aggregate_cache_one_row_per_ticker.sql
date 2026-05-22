-- 013_aggregate_cache_one_row_per_ticker.sql
-- Collapse `aggregate_cache` to a single row per (ticker, adjusted).
--
-- Why:
--   Original PK was (ticker, from_date, to_date, adjusted). iOS requests a
--   rolling window ("today − N" → "today"), so both dates shift by one
--   each day, producing a new PK every day and orphaning the old row.
--   24h TTL is read-time only — no GC. Result: ~365 dead rows per ticker
--   per year of usage, growing linearly forever.
--
-- New shape:
--   PK is (ticker, adjusted). `from_date` and `to_date` become descriptive
--   columns (the window currently held in `bars`), not identity columns.
--   The /aggregates Edge Function does a coverage check: if the cached
--   window covers the requested window AND fetched_at is fresh, slice and
--   return; otherwise re-fetch the union window and overwrite the row.
--   Each ticker monotonically converges to "widest window ever requested",
--   bounded by the universe size, not by time.
--
-- Migration strategy:
--   The table is a pure cache — no data preservation needed. We TRUNCATE
--   to drop all rows (cheap, takes a table lock for milliseconds at our
--   scale), then re-declare the PK. The next read per ticker re-fetches
--   from Polygon and seeds the new row.

BEGIN;

-- Step 1: clear the table. Any orphaned rows from the old PK regime are
-- garbage by definition; preserving them would just defer the cleanup.
TRUNCATE TABLE aggregate_cache;

-- Step 2: drop the old composite PK.
ALTER TABLE aggregate_cache DROP CONSTRAINT aggregate_cache_pkey;

-- Step 3: install the new PK. (ticker, adjusted) — one row per ticker per
-- adjustment flag. In practice iOS always requests adjusted=true, so this
-- is effectively one row per ticker.
ALTER TABLE aggregate_cache ADD PRIMARY KEY (ticker, adjusted);

COMMIT;

-- Comment refresh — the table's purpose changed slightly.
COMMENT ON TABLE  aggregate_cache IS
  'Edge Function cache for historical aggregate bars. One row per (ticker, adjusted); the row holds the widest window ever fetched. Written by /aggregates function only. JSONB bars is an array of AggregateBarDTO.';
COMMENT ON COLUMN aggregate_cache.from_date IS
  'Start of the date range currently held in `bars`. Descriptive — not part of the PK. Monotonically non-increasing across upserts for a given ticker.';
COMMENT ON COLUMN aggregate_cache.to_date IS
  'End of the date range currently held in `bars`. Descriptive — not part of the PK. Monotonically non-decreasing across upserts for a given ticker.';
