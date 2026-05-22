-- 012_aggregate_cache.sql
-- Phase 6 follow-up — Backend pivot, history side.
--
-- Per-(ticker, range, adjusted) cache populated by the /aggregates Edge
-- Function. The Edge Function reads historical daily bars from Polygon
-- and writes the bars array here as JSONB.
--
-- TTL is enforced in TypeScript (Edge Function), not by the database. Rows
-- are never deleted as part of normal operation — they're upserted in
-- place when stale. 24h TTL is appropriate: historical bars don't change
-- once published, and today's intraday bar is acceptable to be stale until
-- the next morning. Pull-to-refresh with `force: true` bypasses the cache
-- read but still upserts (so `fetched_at` updates as proof of work).
--
-- Schema rationale:
--   - Composite PK on (ticker, from_date, to_date, adjusted) — different
--     date ranges of the same ticker are different cache entries. Picking
--     a coarser key (e.g. ticker-only) would force re-fetch on every
--     range change.
--   - `bars` is JSONB. The array can be hundreds to thousands of bars per
--     row; flattening to one row per (ticker, date) would balloon the
--     table without giving us anything: clients always want a contiguous
--     range, never random-access by date.
--
-- Strict separation from `stock_price`:
--   - `stock_price`     is record-of-truth for daily settled closes. Written
--                       only by the overnight Python pipeline.
--   - `aggregate_cache` is a cache. Written only by the /aggregates Edge
--                       Function. Never read by the pipeline.

CREATE TABLE IF NOT EXISTS aggregate_cache (
  ticker      text        NOT NULL,
  from_date   date        NOT NULL,
  to_date     date        NOT NULL,
  adjusted    boolean     NOT NULL DEFAULT true,
  bars        jsonb       NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, from_date, to_date, adjusted)
);

-- Useful for any future GC cron, and for dashboards inspecting cache age.
CREATE INDEX IF NOT EXISTS aggregate_cache_fetched_at_idx
  ON aggregate_cache (fetched_at);

-- The Edge Function uses the service-role key, which bypasses RLS by
-- default. We still enable RLS so any future anon-key reads are explicit
-- about their policy. No policies are created here — anon-key reads are
-- denied until a policy is added.
ALTER TABLE aggregate_cache ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  aggregate_cache IS
  'Edge Function cache for historical aggregate bars. Written by /aggregates function only. JSONB bars is an array of AggregateBarDTO.';
COMMENT ON COLUMN aggregate_cache.bars IS
  'Array of AggregateBarDTO blobs. Shape lives in Edge Function code, not in this schema.';
COMMENT ON COLUMN aggregate_cache.fetched_at IS
  'When this row was last upserted. TTL (24h) is computed at read time in the Edge Function.';
