-- ============================================================
-- StockPulse — 005_global_correlations.sql
-- Precomputed pairwise stock correlations (rolling time series).
-- Run in Supabase SQL Editor AFTER 004.
-- ============================================================

-- ══════════════════════════════════════════════════════════════
-- Table: global_correlations
-- One row per stock pair per lookback period per business day.
-- Computed nightly by the Python backend using price_history data.
-- The iOS app fetches relevant pairs for the correlation simulator.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS global_correlations (
    ticker_a        TEXT NOT NULL,
    ticker_b        TEXT NOT NULL,
    business_date   DATE NOT NULL,
    correlation     DECIMAL(8,6) NOT NULL,      -- Pearson r, range [-1, 1]
    period_days     INTEGER NOT NULL,            -- lookback window: 90 or 252
    calculated_at   TIMESTAMPTZ DEFAULT NOW(),

    -- Enforce ticker_a < ticker_b (using C collation for byte ordering,
    -- which matches Python's string comparison) so each pair is stored exactly once
    CONSTRAINT global_corr_ordered CHECK (ticker_a COLLATE "C" < ticker_b COLLATE "C"),

    -- One row per pair per lookback period per date
    CONSTRAINT global_corr_unique
        UNIQUE (ticker_a, ticker_b, period_days, business_date)
);

-- Primary query pattern: fetch correlations for a set of tickers
-- at a given period on the most recent date
CREATE INDEX IF NOT EXISTS idx_global_corr_lookup
    ON global_correlations (period_days, business_date DESC, ticker_a, ticker_b);

-- Secondary: fetch full time series for one pair
CREATE INDEX IF NOT EXISTS idx_global_corr_pair_history
    ON global_correlations (ticker_a, ticker_b, period_days, business_date DESC);

-- Date-based cleanup / range queries
CREATE INDEX IF NOT EXISTS idx_global_corr_date
    ON global_correlations (business_date);

-- ══════════════════════════════════════════════════════════════
-- RLS: public read (same pattern as price_history)
-- Backend writes via service role key (bypasses RLS).
-- ══════════════════════════════════════════════════════════════

ALTER TABLE global_correlations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "global_corr_read_all" ON global_correlations
    FOR SELECT USING (TRUE);

-- ══════════════════════════════════════════════════════════════
-- Helper function: get latest correlations for a set of tickers
-- Used by the iOS simulator to fetch relevant pairs.
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_portfolio_correlations(
    p_tickers TEXT[],
    p_period INTEGER DEFAULT 90
)
RETURNS TABLE (
    ticker_a    TEXT,
    ticker_b    TEXT,
    correlation DECIMAL,
    business_date DATE
)
LANGUAGE SQL STABLE AS $$
    SELECT gc.ticker_a, gc.ticker_b, gc.correlation, gc.business_date
    FROM global_correlations gc
    WHERE gc.period_days = p_period
      AND gc.ticker_a = ANY(p_tickers)
      AND gc.ticker_b = ANY(p_tickers)
      AND gc.business_date = (
          SELECT MAX(gc2.business_date)
          FROM global_correlations gc2
          WHERE gc2.period_days = p_period
      )
    ORDER BY gc.ticker_a, gc.ticker_b;
$$;

GRANT EXECUTE ON FUNCTION get_portfolio_correlations(TEXT[], INTEGER) TO anon, authenticated;
