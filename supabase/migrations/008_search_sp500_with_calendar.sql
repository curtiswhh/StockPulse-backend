-- ============================================================
-- StockPulse — 008_search_sp500_with_calendar.sql
-- Rebuild search_sp500 to include calendar_code in its output.
-- Run in Supabase SQL Editor AFTER 007.
-- ============================================================
--
-- Why: the original search_sp500 (migration 004) fixed its RETURNS TABLE
-- shape before calendar_code existed on sp500_constituents. The iOS DTO
-- had to carry `calendar_code: String?` as a workaround, which leaked
-- optionality into every call site. This migration updates the RPC to
-- return the column, and the Swift side drops the optional in lockstep.
--
-- Postgres does not allow CREATE OR REPLACE when a function's
-- RETURNS TABLE shape changes, so we DROP first.

DROP FUNCTION IF EXISTS search_sp500(TEXT, INT);

CREATE OR REPLACE FUNCTION search_sp500(p_query TEXT, p_limit INT DEFAULT 15)
RETURNS TABLE (
    ticker          TEXT,
    company_name    TEXT,
    sector          TEXT,
    sub_industry    TEXT,
    is_active       BOOLEAN,
    calendar_code   TEXT
)
LANGUAGE SQL STABLE AS $$
    SELECT
        s.ticker,
        s.company_name,
        s.sector,
        s.sub_industry,
        s.is_active,
        s.calendar_code
    FROM sp500_constituents s
    WHERE
        s.ticker ILIKE (p_query || '%')
        OR s.company_name ILIKE ('%' || p_query || '%')
    ORDER BY
        CASE WHEN UPPER(s.ticker) = UPPER(p_query) THEN 0
             WHEN s.ticker ILIKE (p_query || '%') THEN 1
             ELSE 2
        END,
        s.ticker ASC
    LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION search_sp500(TEXT, INT) TO anon, authenticated;
