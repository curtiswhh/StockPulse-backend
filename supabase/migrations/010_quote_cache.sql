-- 010_quote_cache.sql
-- Phase 5 — Backend pivot.
--
-- One-row-per-ticker cache populated by the /quotes Edge Function. The
-- Edge Function reads live prices from Polygon, fuses with the prev-close
-- from `stock_price`, and writes the fused MarketQuoteDTO here as JSONB.
--
-- TTL is enforced in TypeScript (Edge Function), not by the database. Rows
-- are never deleted as part of normal operation — they're upserted in place
-- when stale. At ~600 S&P + a long tail of off-universe tickers the table
-- stays well under 10k rows; no GC needed at this scale.
--
-- Strict separation from `stock_price`:
--   - `stock_price`  is record-of-truth for daily settled closes. Written
--                    only by the overnight Python pipeline. Read here for
--                    the prev-close field of each quote.
--   - `quote_cache`  is a cache. Written only by the Edge Function. Never
--                    read by the pipeline.

CREATE TABLE IF NOT EXISTS quote_cache (
  ticker      text        PRIMARY KEY,
  payload     jsonb       NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

-- Useful for any future GC cron, and for dashboards inspecting cache age.
CREATE INDEX IF NOT EXISTS quote_cache_fetched_at_idx
  ON quote_cache (fetched_at);

-- The Edge Function uses the service-role key, which bypasses RLS by
-- default. We still enable RLS so any future anon-key reads are explicit
-- about their policy. No policies are created here — anon-key reads are
-- denied until a policy is added (Phase 8+ if we ever expose this table).
ALTER TABLE quote_cache ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  quote_cache IS
  'Edge Function cache for live quotes. Written by /quotes function only. JSONB payload is a MarketQuoteDTO.';
COMMENT ON COLUMN quote_cache.payload IS
  'Full MarketQuoteDTO blob. Shape lives in Edge Function code, not in this schema.';
COMMENT ON COLUMN quote_cache.fetched_at IS
  'When this row was last upserted. TTL is computed at read time in the Edge Function.';
