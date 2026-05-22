-- 018_alerts_price_snapshots.sql
-- Phase 7a — Server-side push alerts.
--
-- Per-minute price feed for the alert evaluator. Strict separation from the
-- three existing price-data surfaces (see /supabase/functions/_shared and
-- migrations 010-013 for context):
--
--   stock_price       — daily settled closes. Record-of-truth. Python pipeline only.
--   quote_cache       — on-demand live quotes. Written by /quotes when iOS asks.
--   aggregate_cache   — on-demand historical bars. Written by /aggregates when iOS asks.
--   price_snapshots   — fixed-cadence per-minute prices. Written by /tick (PR 2).
--                       ⤷ THIS FILE
--
-- The three on-demand caches above are useless as the alert feed because
-- they only update when iOS asks for the ticker — a user who set an alert
-- and closed the app would never see them refresh. Hence this table.
--
-- Scope: tickers are the union of all enabled-alert tickers. If nobody has
-- an alert on AAPL, AAPL is not in this table. Bounds Polygon cost to
-- "tickers users care about", not the S&P 500.
--
-- Columns:
--   price         Polygon snapshot's lastTrade.p (or fallback). Numeric, matches
--                 stock_price.close convention.
--   price_return  Polygon snapshot's todaysChangePerc — percent change vs the
--                 previous trading day's close. Decimal percent (e.g. 5.2 not 0.052).
--                 Letting /tick cache this means the price_move_1d evaluator
--                 doesn't need a separate stock_price lookup at every tick.
--   volume        Day-running volume. NULL if Polygon didn't include it.
--                 Not currently consumed; cheap to capture for future use.
--
-- Retention: rolling 14 calendar days, pruned nightly by 019. That's enough
-- for max_n_days=10 business days with weekend/holiday padding. If we later
-- raise max_n_days substantially, the right move is to splice from
-- stock_price for the older anchor — not to grow this table without bound.

CREATE TABLE IF NOT EXISTS price_snapshots (
  ticker        text         NOT NULL,
  ts            timestamptz  NOT NULL,
  price         numeric      NOT NULL,
  price_return  numeric,
  volume        bigint,
  PRIMARY KEY (ticker, ts)
);

-- Hot path for the evaluator: "give me the last N days of ticker X, newest
-- first". The PK already provides (ticker, ts) ascending; an explicit DESC
-- index makes the latest-snapshot lookup index-only.
CREATE INDEX IF NOT EXISTS price_snapshots_ticker_ts_desc_idx
  ON price_snapshots (ticker, ts DESC);

-- Service-role writes only. iOS does NOT read this table directly — it
-- reads alert_fires and notifications, which carry the prices baked in.
-- RLS enabled with no policies = denied for anon/authenticated.
ALTER TABLE price_snapshots ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  price_snapshots IS
  'Per-minute price feed for the alert evaluator. Written by /tick only. Rolling 14d retention.';
COMMENT ON COLUMN price_snapshots.price IS
  'Polygon snapshot price at the tick timestamp. Numeric, not double — same convention as stock_price.close.';
COMMENT ON COLUMN price_snapshots.price_return IS
  'Percent change vs previous trading day''s close (Polygon todaysChangePerc). Decimal percent: 5.2 means 5.2%, not 520%. Powers the price_move_1d evaluator.';
COMMENT ON COLUMN price_snapshots.volume IS
  'Day-running volume from the Polygon snapshot. NULL when snapshot returned no volume field. Captured for future volume-based alert types.';
