-- ============================================================
-- StockPulse — Migration 004: S&P 500 search support
-- Run in Supabase SQL Editor
-- ============================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- 1) Add a text-search-friendly index for company_name (case-insensitive)
CREATE INDEX IF NOT EXISTS idx_sp500_ticker_trgm
    ON sp500_constituents USING gin (ticker gin_trgm_ops);

-- NOTE: If the pg_trgm extension is not enabled, run this first:
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- If you can't enable pg_trgm, skip the index above — the function
-- below will still work, just slightly slower (negligible for ~500 rows).

-- 2) Postgres function: search constituents by ticker or company name
--    Returns all rows (active + dormant) ranked by relevance:
--      - Exact ticker match first
--      - Ticker prefix match next
--      - Company name substring match last
--    Within each group, results are sorted alphabetically by ticker.

CREATE OR REPLACE FUNCTION search_sp500(p_query TEXT, p_limit INT DEFAULT 15)
RETURNS TABLE (
    ticker          TEXT,
    company_name    TEXT,
    sector          TEXT,
    sub_industry    TEXT,
    is_active       BOOLEAN
)
LANGUAGE SQL STABLE AS $$
    SELECT
        s.ticker,
        s.company_name,
        s.sector,
        s.sub_industry,
        s.is_active
    FROM sp500_constituents s
    WHERE
        s.ticker ILIKE (p_query || '%')
        OR s.company_name ILIKE ('%' || p_query || '%')
    ORDER BY
        -- Exact ticker match first
        CASE WHEN UPPER(s.ticker) = UPPER(p_query) THEN 0
        -- Ticker prefix match next
             WHEN s.ticker ILIKE (p_query || '%') THEN 1
        -- Company name match last
             ELSE 2
        END,
        s.ticker ASC
    LIMIT p_limit;
$$;

-- 3) Grant access so the anon/authenticated roles can call this function
GRANT EXECUTE ON FUNCTION search_sp500(TEXT, INT) TO anon, authenticated;