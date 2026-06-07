-- ============================================================
-- StockPulse — 106_index_list_price_return.sql
-- Adds index price/return scraping. Run in Supabase SQL Editor AFTER 105.
-- ============================================================
--
-- Three tables, mirroring the stock side:
--
--   1. index_list    — catalog of indices the pipeline scrapes. The REPO FILE
--                       config/index_list.py is the gold source; IndexTracker
--                       syncs it here each run (upsert + soft-delete). The
--                       pipeline scrapes only rows WHERE is_active.
--
--   2. index_price   — daily OHLCV, column-for-column copy of stock_price.
--   3. index_return  — daily simple returns, column-for-column copy of
--                       stock_return.
--
-- `ticker` / `symbol` holds the native Yahoo symbol (e.g. '^GSPC'), used as
-- the key across all three tables. No vendor mapping — yfinance takes it raw.
-- This stream is independent of Polygon and polygon_index_list.


-- ══════════════════════════════════════════════════════════════
-- 1. index_list — synced from config/index_list.py each run
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS index_list (
    symbol      TEXT PRIMARY KEY,                 -- native Yahoo symbol (e.g. '^GSPC')
    name        TEXT NOT NULL,                    -- full name (e.g. 'S&P 500')
    region      TEXT,                             -- e.g. 'US', 'Europe'
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    removed_at  TIMESTAMPTZ
);

GRANT SELECT ON index_list TO anon, authenticated;

ALTER TABLE index_list ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "index_list_read_all" ON index_list;
CREATE POLICY "index_list_read_all" ON index_list
    FOR SELECT USING (TRUE);

-- Seed the starting set (keep in sync with config/index_list.py).
INSERT INTO index_list (symbol, name, region) VALUES
    ('^GSPC', 'S&P 500', 'US'),
    ('^DJI', 'Dow Jones Industrial Average', 'US'),
    ('^IXIC', 'NASDAQ Composite', 'US'),
    ('^NYA', 'NYSE Composite Index', 'US'),
    ('^XAX', 'NYSE American Composite Index', 'US'),
    ('^RUT', 'Russell 2000 Index', 'US'),
    ('^VIX', 'CBOE Volatility Index', 'US'),
    ('^BUK100P', 'Cboe UK 100', 'Europe'),
    ('^FTSE', 'FTSE 100', 'Europe'),
    ('^GDAXI', 'DAX P', 'Europe'),
    ('^FCHI', 'CAC 40', 'Europe'),
    ('^STOXX50E', 'EURO STOXX 50', 'Europe'),
    ('^N100', 'Euronext 100 Index', 'Europe'),
    ('^BFX', 'BEL 20', 'Europe'),
    ('^HSI', 'HANG SENG INDEX', 'Asia'),
    ('^STI', 'STI Index', 'Asia'),
    ('^AXJO', 'S&P/ASX 200', 'Asia'),
    ('^AORD', 'ALL ORDINARIES', 'Asia'),
    ('^BSESN', 'S&P BSE SENSEX', 'Asia'),
    ('^JKSE', 'IDX COMPOSITE', 'Asia'),
    ('^KLSE', 'FTSE Bursa Malaysia KLCI', 'Asia'),
    ('^NZ50', 'S&P/NZX 50 INDEX GROSS', 'Asia'),
    ('^KS11', 'KOSPI Composite Index', 'Asia'),
    ('^TWII', 'TWSE Capitalization Weighted Stock Index', 'Asia'),
    ('^GSPTSE', 'S&P/TSX Composite Index', 'Americas'),
    ('^BVSP', 'IBOVESPA', 'Americas'),
    ('^MXX', 'IPC MEXICO', 'Americas'),
    ('^MERV', 'MERVAL', 'Americas'),
    ('^TA125.TA', 'TA-125', 'Middle East'),
    ('^JN0U.JO', 'Top 40 USD Net TRI Index', 'Africa'),
    ('DX-Y.NYB', 'US Dollar Index', 'Currency'),
    ('^125904-USD-STRD', 'MSCI EUROPE', 'Europe'),
    ('^XDB', 'British Pound Currency Index', 'Currency'),
    ('^XDE', 'Euro Currency Index', 'Currency'),
    ('000001.SS', 'SSE Composite Index', 'Asia'),
    ('^N225', 'Nikkei 225', 'Asia'),
    ('^XDN', 'Japanese Yen Currency Index', 'Currency'),
    ('^XDA', 'Australian Dollar Currency Index', 'Currency')
ON CONFLICT (symbol) DO NOTHING;


-- ══════════════════════════════════════════════════════════════
-- 2. index_price — mirrors stock_price
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS index_price (
    ticker        TEXT NOT NULL,
    business_date DATE NOT NULL,
    open          DECIMAL(12,4),
    high          DECIMAL(12,4),
    low           DECIMAL(12,4),
    close         DECIMAL(12,4),
    volume        BIGINT,
    adj_close     DECIMAL(12,4),

    CONSTRAINT index_price_pkey
        PRIMARY KEY (ticker, business_date)
);

CREATE INDEX IF NOT EXISTS idx_index_price_ticker_date_desc
    ON index_price (ticker, business_date DESC);

ALTER TABLE index_price ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "index_price_read_all" ON index_price;
CREATE POLICY "index_price_read_all" ON index_price
    FOR SELECT USING (TRUE);


-- ══════════════════════════════════════════════════════════════
-- 3. index_return — mirrors stock_return
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS index_return (
    ticker          TEXT           NOT NULL,
    business_date   DATE           NOT NULL,
    daily_return    NUMERIC(10, 6) NULL,
    reference_price DECIMAL(12, 4) NULL,
    computed_at     TIMESTAMPTZ    NULL DEFAULT NOW(),

    CONSTRAINT index_return_pkey
        PRIMARY KEY (ticker, business_date)
);

CREATE INDEX IF NOT EXISTS idx_index_return_ticker_date
    ON index_return (ticker, business_date DESC);

CREATE INDEX IF NOT EXISTS idx_index_return_date
    ON index_return (business_date);

ALTER TABLE index_return ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "index_return_read_all" ON index_return;
CREATE POLICY "index_return_read_all" ON index_return
    FOR SELECT USING (TRUE);