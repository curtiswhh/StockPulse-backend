-- ============================================================
-- StockPulse — Supabase Migration (same for test & production)
-- Run in Supabase SQL Editor AFTER 001_initial_schema.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS sp500_constituents (
    ticker          TEXT PRIMARY KEY,
    company_name    TEXT NOT NULL,
    sector          TEXT,
    sub_industry    TEXT,
    date_added_to_sp500 TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    removed_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sp500_active
    ON sp500_constituents (is_active) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS var_calculations_precomputed (
    id              BIGINT GENERATED ALWAYS AS IDENTITY,
    ticker          TEXT NOT NULL,
    calc_date       DATE NOT NULL,
    confidence_level DECIMAL(4,3) NOT NULL,
    lookback_days   INTEGER NOT NULL,
    method          TEXT NOT NULL DEFAULT 'historical_simulation',
    var_lower       DECIMAL(12,4),
    var_upper       DECIMAL(12,4),
    var_pct_lower   DECIMAL(10,6),
    var_pct_upper   DECIMAL(10,6),
    reference_price DECIMAL(12,4),
    computed_at     TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT var_precomputed_unique
        UNIQUE (ticker, calc_date, confidence_level, lookback_days)
);

CREATE INDEX IF NOT EXISTS idx_var_ticker_date
    ON var_calculations_precomputed (ticker, calc_date DESC);
CREATE INDEX IF NOT EXISTS idx_var_ticker_date_lookback
    ON var_calculations_precomputed (ticker, calc_date DESC, lookback_days);
CREATE INDEX IF NOT EXISTS idx_var_calc_date
    ON var_calculations_precomputed (calc_date);

ALTER TABLE sp500_constituents ENABLE ROW LEVEL SECURITY;
ALTER TABLE var_calculations_precomputed ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sp500_read_all" ON sp500_constituents FOR SELECT USING (TRUE);
CREATE POLICY "var_read_all" ON var_calculations_precomputed FOR SELECT USING (TRUE);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes WHERE indexname = 'price_history_ticker_date_unique'
    ) THEN
        CREATE UNIQUE INDEX price_history_ticker_date_unique ON price_history (ticker, date);
    END IF;
END $$;

CREATE OR REPLACE FUNCTION get_var_for_stock(
    p_ticker TEXT, p_confidence DECIMAL DEFAULT 0.950, p_lookback INTEGER DEFAULT 252
) RETURNS TABLE (
    calc_date DATE, var_lower DECIMAL, var_upper DECIMAL,
    var_pct_lower DECIMAL, var_pct_upper DECIMAL, reference_price DECIMAL
) LANGUAGE SQL STABLE AS $$
    SELECT calc_date, var_lower, var_upper, var_pct_lower, var_pct_upper, reference_price
    FROM var_calculations_precomputed
    WHERE ticker = p_ticker AND confidence_level = p_confidence AND lookback_days = p_lookback
    ORDER BY calc_date DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION get_var_all_levels(
    p_ticker TEXT, p_lookback INTEGER DEFAULT 252
) RETURNS TABLE (
    confidence_level DECIMAL, var_lower DECIMAL, var_upper DECIMAL,
    var_pct_lower DECIMAL, var_pct_upper DECIMAL, reference_price DECIMAL
) LANGUAGE SQL STABLE AS $$
    SELECT confidence_level, var_lower, var_upper, var_pct_lower, var_pct_upper, reference_price
    FROM var_calculations_precomputed
    WHERE ticker = p_ticker AND lookback_days = p_lookback
      AND calc_date = (
          SELECT MAX(calc_date) FROM var_calculations_precomputed
          WHERE ticker = p_ticker AND lookback_days = p_lookback
      )
    ORDER BY confidence_level ASC;
$$;
