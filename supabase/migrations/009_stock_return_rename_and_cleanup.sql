-- ============================================================
-- StockPulse — 009_stock_return_rename_and_cleanup.sql
-- Run in Supabase SQL Editor AFTER 008.
--
-- This migration does three things atomically:
--
--  1. Creates a dedicated stock_return table — the single source
--     of truth for daily simple returns. Per-day daily_return is
--     lookback-independent, so the PK is (ticker, business_date).
--
--  2. Renames three tables for naming consistency with the new
--     stock_return / stock_volatility pattern:
--       price_history                → stock_price
--       var_calculations_precomputed → stock_var
--       global_correlations          → stock_correlation
--     All dependent SQL functions are dropped and recreated.
--
--  3. Drops dead code:
--       - var_calculations        (original on-device table, unused)
--
-- Note: daily_return column is left in place on stock_var and
-- stock_volatility for this round (avoids breaking anything that
-- still reads it). Python backend will stop writing it in a follow-up
-- round once all Swift consumers are migrated to stock_return.
-- ============================================================


-- ══════════════════════════════════════════════════════════════
-- 1. Create stock_return table (dedicated, single source of truth)
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS stock_return (
    ticker          TEXT           NOT NULL,
    business_date   DATE           NOT NULL,
    daily_return    NUMERIC(10, 6) NULL,       -- r_t = (P_t - P_{t-1}) / P_{t-1}
    reference_price DECIMAL(12, 4) NULL,       -- close (or adj_close) used for r_t
    computed_at     TIMESTAMPTZ    NULL DEFAULT NOW(),

    CONSTRAINT stock_return_pkey
        PRIMARY KEY (ticker, business_date)
);

-- Primary query: iOS fetches time series by ticker + date range
CREATE INDEX IF NOT EXISTS idx_stock_return_ticker_date
    ON stock_return (ticker, business_date DESC);

-- Date-based queries (e.g. join breaches on date)
CREATE INDEX IF NOT EXISTS idx_stock_return_date
    ON stock_return (business_date);

ALTER TABLE stock_return ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "stock_return_read_all" ON stock_return;
CREATE POLICY "stock_return_read_all" ON stock_return
    FOR SELECT USING (TRUE);


-- ══════════════════════════════════════════════════════════════
-- 2. Drop all RPC functions that reference old table names.
--    Required before renaming, because functions pin to table names
--    at definition time.
--    (get_var_all_levels was already dropped manually — omitted here.)
-- ══════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS get_var_for_stock(TEXT, DECIMAL, INTEGER);
DROP FUNCTION IF EXISTS get_portfolio_correlations(TEXT[], INTEGER);
DROP FUNCTION IF EXISTS get_portfolio_volatilities(TEXT[], INTEGER);
DROP FUNCTION IF EXISTS get_post_breach_stats(TEXT, DECIMAL, INTEGER, DATE);


-- ══════════════════════════════════════════════════════════════
-- 3. Rename tables
-- ══════════════════════════════════════════════════════════════

ALTER TABLE IF EXISTS price_history                RENAME TO stock_price;
ALTER TABLE IF EXISTS var_calculations_precomputed RENAME TO stock_var;
ALTER TABLE IF EXISTS global_correlations          RENAME TO stock_correlation;


-- ══════════════════════════════════════════════════════════════
-- 3b. Rename named constraints (defensive — only rename when a
--     constraint with the old name actually exists).
--
--     Supabase/Postgres sometimes stores UNIQUE as an implicit
--     index-backed constraint under a different name, so we don't
--     rely on the names from earlier migrations.
-- ══════════════════════════════════════════════════════════════

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'var_precomputed_unique'
          AND conrelid = 'stock_var'::regclass
    ) THEN
        ALTER TABLE stock_var RENAME CONSTRAINT var_precomputed_unique TO stock_var_unique;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'global_corr_ordered'
          AND conrelid = 'stock_correlation'::regclass
    ) THEN
        ALTER TABLE stock_correlation RENAME CONSTRAINT global_corr_ordered TO stock_correlation_ordered;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'global_corr_unique'
          AND conrelid = 'stock_correlation'::regclass
    ) THEN
        ALTER TABLE stock_correlation RENAME CONSTRAINT global_corr_unique TO stock_correlation_unique;
    END IF;
END $$;


-- ══════════════════════════════════════════════════════════════
-- 4. Drop dead table: var_calculations (original on-device design,
--    never populated by the backend; iOS uses stock_var instead).
-- ══════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS var_calculations CASCADE;


-- ══════════════════════════════════════════════════════════════
-- 5. Recreate RPC functions against the renamed tables.
--    Signatures unchanged — callers (Swift) continue to work.
-- ══════════════════════════════════════════════════════════════

-- get_var_for_stock: latest VaR row for one ticker
CREATE OR REPLACE FUNCTION get_var_for_stock(
    p_ticker TEXT, p_confidence DECIMAL DEFAULT 0.950, p_lookback INTEGER DEFAULT 252
) RETURNS TABLE (
    business_date DATE, var_lower DECIMAL, var_upper DECIMAL,
    var_pct_lower DECIMAL, var_pct_upper DECIMAL, reference_price DECIMAL
) LANGUAGE SQL STABLE AS $$
    SELECT business_date, var_lower, var_upper, var_pct_lower, var_pct_upper, reference_price
    FROM stock_var
    WHERE ticker = p_ticker
      AND confidence_level = p_confidence
      AND lookback_days = p_lookback
    ORDER BY business_date DESC LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_var_for_stock(TEXT, DECIMAL, INTEGER) TO anon, authenticated;


-- get_portfolio_correlations: latest-date pairwise correlations for a ticker set
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
    SELECT sc.ticker_a, sc.ticker_b, sc.correlation, sc.business_date
    FROM stock_correlation sc
    WHERE sc.period_days = p_period
      AND sc.ticker_a = ANY(p_tickers)
      AND sc.ticker_b = ANY(p_tickers)
      AND sc.business_date = (
          SELECT MAX(sc2.business_date)
          FROM stock_correlation sc2
          WHERE sc2.period_days = p_period
      )
    ORDER BY sc.ticker_a, sc.ticker_b;
$$;

GRANT EXECUTE ON FUNCTION get_portfolio_correlations(TEXT[], INTEGER) TO anon, authenticated;


-- get_portfolio_volatilities: latest vol row per ticker
CREATE OR REPLACE FUNCTION get_portfolio_volatilities(
    p_tickers TEXT[],
    p_lookback INTEGER DEFAULT 252
)
RETURNS TABLE (
    ticker         TEXT,
    business_date  DATE,
    daily_vol      NUMERIC,
    annualized_vol NUMERIC
)
LANGUAGE SQL STABLE AS $$
    SELECT DISTINCT ON (sv.ticker)
        sv.ticker,
        sv.business_date,
        sv.daily_vol,
        sv.annualized_vol
    FROM stock_volatility sv
    WHERE sv.ticker = ANY(p_tickers)
      AND sv.lookback_days = p_lookback
      AND sv.daily_vol IS NOT NULL
    ORDER BY sv.ticker, sv.business_date DESC;
$$;

GRANT EXECUTE ON FUNCTION get_portfolio_volatilities(TEXT[], INTEGER) TO anon, authenticated;


-- get_post_breach_stats: forward-return analysis for VaR breaches
CREATE OR REPLACE FUNCTION get_post_breach_stats(
    p_ticker     TEXT,
    p_confidence DECIMAL DEFAULT 0.950,
    p_lookback   INTEGER DEFAULT 252,
    p_since_date DATE    DEFAULT NULL
)
RETURNS TABLE (
    scope                       TEXT,
    direction                   TEXT,
    horizon_label               TEXT,
    horizon_days                INTEGER,
    total_breaches              INTEGER,
    reversal_count              INTEGER,
    reversal_pct                DECIMAL,
    avg_forward_return_pct      DECIMAL,
    median_forward_return_pct   DECIMAL
)
LANGUAGE SQL STABLE AS $$
WITH
ph AS (
    SELECT
        business_date,
        close,
        ROW_NUMBER() OVER (ORDER BY business_date) AS rn
    FROM stock_price
    WHERE ticker = p_ticker
),
all_breaches AS (
    SELECT
        v.business_date,
        v.breach_lower,
        v.breach_upper,
        ph.rn    AS breach_rn,
        ph.close AS breach_close
    FROM stock_var v
    JOIN ph ON ph.business_date = v.business_date
    WHERE v.ticker           = p_ticker
      AND v.confidence_level = p_confidence
      AND v.lookback_days    = p_lookback
      AND (v.breach_lower = TRUE OR v.breach_upper = TRUE)
),
horizons(h) AS (
    VALUES (1), (5), (30)
),
all_forward AS (
    SELECT
        'all_time'::TEXT AS scope,
        b.breach_lower,
        b.breach_upper,
        h.h              AS horizon,
        ((fwd.close - b.breach_close) / NULLIF(b.breach_close, 0)) * 100 AS fwd_return_pct
    FROM all_breaches b
    CROSS JOIN horizons h
    JOIN ph fwd ON fwd.rn = b.breach_rn + h.h
),
period_forward AS (
    SELECT
        'period'::TEXT AS scope,
        b.breach_lower,
        b.breach_upper,
        h.h            AS horizon,
        ((fwd.close - b.breach_close) / NULLIF(b.breach_close, 0)) * 100 AS fwd_return_pct
    FROM all_breaches b
    CROSS JOIN horizons h
    JOIN ph fwd ON fwd.rn = b.breach_rn + h.h
    WHERE p_since_date IS NOT NULL
      AND b.business_date >= p_since_date
),
combined AS (
    SELECT * FROM all_forward
    UNION ALL
    SELECT * FROM period_forward
),
lower_stats AS (
    SELECT
        c.scope,
        'lower'::TEXT                           AS direction,
        'T+' || c.horizon::TEXT                 AS horizon_label,
        c.horizon                               AS horizon_days,
        COUNT(*)::INTEGER                       AS total_breaches,
        COUNT(*) FILTER (WHERE fwd_return_pct > 0)::INTEGER AS reversal_count,
        CASE WHEN COUNT(*) > 0
             THEN ROUND((COUNT(*) FILTER (WHERE fwd_return_pct > 0)::DECIMAL / COUNT(*)) * 100, 2)
             ELSE 0 END                         AS reversal_pct,
        COALESCE(ROUND(AVG(fwd_return_pct), 4), 0) AS avg_forward_return_pct,
        COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY fwd_return_pct)::NUMERIC, 4), 0)
                                                AS median_forward_return_pct
    FROM combined c
    WHERE c.breach_lower = TRUE
    GROUP BY c.scope, c.horizon
),
upper_stats AS (
    SELECT
        c.scope,
        'upper'::TEXT                           AS direction,
        'T+' || c.horizon::TEXT                 AS horizon_label,
        c.horizon                               AS horizon_days,
        COUNT(*)::INTEGER                       AS total_breaches,
        COUNT(*) FILTER (WHERE fwd_return_pct < 0)::INTEGER AS reversal_count,
        CASE WHEN COUNT(*) > 0
             THEN ROUND((COUNT(*) FILTER (WHERE fwd_return_pct < 0)::DECIMAL / COUNT(*)) * 100, 2)
             ELSE 0 END                         AS reversal_pct,
        COALESCE(ROUND(AVG(fwd_return_pct), 4), 0) AS avg_forward_return_pct,
        COALESCE(ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY fwd_return_pct)::NUMERIC, 4), 0)
                                                AS median_forward_return_pct
    FROM combined c
    WHERE c.breach_upper = TRUE
    GROUP BY c.scope, c.horizon
)
SELECT * FROM lower_stats
UNION ALL
SELECT * FROM upper_stats
ORDER BY scope DESC, direction, horizon_days;
$$;

GRANT EXECUTE ON FUNCTION get_post_breach_stats(TEXT, DECIMAL, INTEGER, DATE) TO anon, authenticated;


-- ══════════════════════════════════════════════════════════════
-- Done. Next steps (outside this migration):
--   • Backfill stock_return by running:
--       python main.py --compute-returns-all
--   • In a follow-up round, stop writing daily_return into stock_var
--     and stock_volatility, and drop those columns.
-- ══════════════════════════════════════════════════════════════
