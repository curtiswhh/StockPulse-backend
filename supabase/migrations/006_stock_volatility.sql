-- ============================================================
-- StockPulse — 006_stock_volatility.sql
-- Per-stock rolling daily volatility (annualized σ).
-- Run in Supabase SQL Editor AFTER 005.
-- ============================================================

-- ══════════════════════════════════════════════════════════════
-- Table: stock_volatility
-- One row per stock per lookback period per business day.
-- Computed nightly by the Python backend from price_history data.
-- The iOS app fetches latest vols to build the covariance matrix
-- for on-device parametric portfolio VaR.
--
-- Column order follows the computation flow:
--   return → vol → lookback context → annualized → metadata
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS stock_volatility (
    ticker          TEXT        NOT NULL,
    business_date   DATE        NOT NULL,
    daily_return    NUMERIC(10, 6) NULL,       -- simple daily return r_t = (P_t - P_{t-1}) / P_{t-1}
    daily_vol       NUMERIC(10, 6) NULL,       -- σ_daily = std(returns over lookback window)
    lookback_days   INTEGER     NOT NULL,      -- rolling window size (e.g. 252)
    annualized_vol  NUMERIC(10, 6) NULL,       -- σ_annual = σ_daily × √252
    return_count    INTEGER     NULL,          -- number of returns in the lookback window
    computed_at     TIMESTAMPTZ NULL DEFAULT NOW(),

    CONSTRAINT stock_volatility_pkey
        PRIMARY KEY (ticker, business_date, lookback_days)
);

-- Primary query: iOS fetches latest vol per ticker
CREATE INDEX IF NOT EXISTS idx_stock_vol_ticker_date
    ON stock_volatility (ticker, business_date DESC, lookback_days);

-- Pipeline: batch queries by date
CREATE INDEX IF NOT EXISTS idx_stock_vol_date
    ON stock_volatility (business_date);

-- ══════════════════════════════════════════════════════════════
-- RLS: public read (same pattern as price_history, global_correlations)
-- Backend writes via service role key (bypasses RLS).
-- ══════════════════════════════════════════════════════════════

ALTER TABLE stock_volatility ENABLE ROW LEVEL SECURITY;

CREATE POLICY "stock_vol_read_all" ON stock_volatility
    FOR SELECT USING (TRUE);

-- ══════════════════════════════════════════════════════════════
-- Helper function: get latest volatility for a set of tickers.
-- Used by iOS to fetch the one most-recent vol row per ticker
-- in a single RPC call for portfolio VaR computation.
--
-- Returns one row per ticker (the most recent business_date
-- where daily_vol is not null for the given lookback).
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_portfolio_volatilities(
    p_tickers TEXT[],
    p_lookback INTEGER DEFAULT 252
)
RETURNS TABLE (
    ticker         TEXT,
    business_date  DATE,
    daily_return   NUMERIC,
    daily_vol      NUMERIC,
    annualized_vol NUMERIC
)
LANGUAGE SQL STABLE AS $$
    SELECT DISTINCT ON (sv.ticker)
        sv.ticker,
        sv.business_date,
        sv.daily_return,
        sv.daily_vol,
        sv.annualized_vol
    FROM stock_volatility sv
    WHERE sv.ticker = ANY(p_tickers)
      AND sv.lookback_days = p_lookback
      AND sv.daily_vol IS NOT NULL
    ORDER BY sv.ticker, sv.business_date DESC;
$$;

GRANT EXECUTE ON FUNCTION get_portfolio_volatilities(TEXT[], INTEGER) TO anon, authenticated;
