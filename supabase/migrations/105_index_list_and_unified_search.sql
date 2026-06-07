-- ============================================================
-- StockPulse — 105_index_list_and_unified_search.sql
-- Adds index support to search. Run in Supabase SQL Editor AFTER 104.
-- ============================================================
--
-- Two parts:
--   1. polygon_index_list — a curated catalog of market indices. Each row
--      stores a VENDOR-NEUTRAL canonical ticker (e.g. 'SPX'), never the
--      Polygon 'I:SPX' form. The 'I:' prefix is vendor-specific and lives
--      only in the Edge Function (_shared/polygon.ts), so swapping data
--      vendors later touches that one file, not stored tickers.
--
--      It is a list OF indices (a catalog), not constituents of an index —
--      hence 'index_list', distinct from stock_sp500_constituents.
--
--   2. search_sp500 — extended to UNION the index catalog in, and to return
--      a new 'asset_class' column ('stock' | 'index'). The function name is
--      kept so iOS keeps calling it unchanged; the existing iOS DTO decodes
--      only ticker/company_name/sector, so the extra columns are ignored
--      until the client opts in.
--
--      Index rows match on canonical ticker OR display_symbol OR name, so a
--      user typing 'SPX', 'S&P', or 'volatility' all resolve correctly —
--      stock-style ticker-prefix matching alone wouldn't surface them.

-- ── Part 1: catalog table ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS polygon_index_list (
    ticker          TEXT PRIMARY KEY,          -- canonical, vendor-neutral (e.g. 'SPX')
    display_symbol  TEXT NOT NULL,             -- short human form shown/searched (e.g. 'SPX')
    name            TEXT NOT NULL,             -- full name (e.g. 'S&P 500 Index')
    family          TEXT,                      -- e.g. 'S&P', 'Nasdaq', 'CBOE'
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

GRANT SELECT ON polygon_index_list TO anon, authenticated;

-- Seed the supported set. Keep in sync with INDEX_CANONICAL in
-- _shared/polygon.ts — that set is what routes a ticker to the v3 endpoints.
INSERT INTO polygon_index_list (ticker, display_symbol, name, family) VALUES
    ('SPX', 'SPX', 'S&P 500 Index',                 'S&P'),
    ('NDX', 'NDX', 'Nasdaq-100 Index',              'Nasdaq'),
    ('DJI', 'DJI', 'Dow Jones Industrial Average',  'Dow Jones'),
    ('VIX', 'VIX', 'CBOE Volatility Index',         'CBOE'),
    ('RUT', 'RUT', 'Russell 2000 Index',            'Russell')
ON CONFLICT (ticker) DO NOTHING;

-- ── Part 2: unified search ────────────────────────────────────
-- RETURNS TABLE shape changes (adds asset_class), so DROP first.
DROP FUNCTION IF EXISTS search_sp500(TEXT, INT);

CREATE OR REPLACE FUNCTION search_sp500(p_query TEXT, p_limit INT DEFAULT 15)
RETURNS TABLE (
    ticker          TEXT,
    company_name    TEXT,
    sector          TEXT,
    sub_industry    TEXT,
    is_active       BOOLEAN,
    calendar_code   TEXT,
    asset_class     TEXT
)
LANGUAGE SQL STABLE AS $$
    SELECT
        combined.ticker,
        combined.company_name,
        combined.sector,
        combined.sub_industry,
        combined.is_active,
        combined.calendar_code,
        combined.asset_class
    FROM (
        -- Stocks (unchanged shape, asset_class tagged).
        SELECT
            s.ticker,
            s.company_name,
            s.sector,
            s.sub_industry,
            s.is_active,
            s.calendar_code,
            'stock'::TEXT AS asset_class,
            CASE WHEN UPPER(s.ticker) = UPPER(p_query) THEN 0
                 WHEN s.ticker ILIKE (p_query || '%')   THEN 1
                 ELSE 2 END AS rank
        FROM stock_sp500_constituents s
        WHERE s.ticker ILIKE (p_query || '%')
           OR s.company_name ILIKE ('%' || p_query || '%')

        UNION ALL

        -- Indices (canonical ticker maps to ticker/sector nulls; name maps
        -- to company_name so the existing iOS DTO renders it as the title).
        SELECT
            i.ticker,
            i.name            AS company_name,
            i.family          AS sector,
            NULL::TEXT        AS sub_industry,
            i.is_active,
            NULL::TEXT        AS calendar_code,
            'index'::TEXT     AS asset_class,
            CASE WHEN UPPER(i.display_symbol) = UPPER(p_query) THEN 0
                 WHEN i.display_symbol ILIKE (p_query || '%')   THEN 1
                 ELSE 2 END AS rank
        FROM polygon_index_list i
        WHERE i.is_active
          AND ( i.display_symbol ILIKE ('%' || p_query || '%')
             OR i.ticker         ILIKE ('%' || p_query || '%')
             OR i.name           ILIKE ('%' || p_query || '%') )
    ) combined
    ORDER BY combined.rank, combined.ticker ASC
    LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION search_sp500(TEXT, INT) TO anon, authenticated;

-- Smoke tests (run manually):
--   SELECT * FROM search_sp500('SPX');   -- expect the S&P 500 index row
--   SELECT * FROM search_sp500('AAP');   -- expect AAPL, asset_class = 'stock'
--   SELECT * FROM search_sp500('vol');   -- expect VIX via name match
