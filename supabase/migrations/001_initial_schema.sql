-- ============================================================
-- StockPulse — 001_initial_schema.sql
-- Full PostgreSQL schema with Row Level Security (RLS)
-- Run this in Supabase SQL Editor FIRST, before 002.
-- ============================================================


-- ══════════════════════════════════════════════════════════════
-- Enable required extensions
-- ══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ══════════════════════════════════════════════════════════════
-- Table: users
-- Stores user accounts and their default VaR preferences.
-- Linked to Supabase Auth via the id (UUID).
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
    id                  UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email               TEXT,
    display_name        TEXT,
    default_confidence  DECIMAL(4,3) DEFAULT 0.950,       -- e.g., 0.950
    default_horizon     TEXT DEFAULT '1d',                 -- '1d' or '1w'
    default_method      TEXT DEFAULT 'historical',         -- 'historical', 'parametric', 'montecarlo'
    quiet_hours_start   TIME,                              -- e.g., 22:00
    quiet_hours_end     TIME,                              -- e.g., 07:00
    apns_token          TEXT,                              -- Apple Push Notification token
    subscription_tier   TEXT DEFAULT 'free',               -- 'free' or 'pro'
    created_at          TIMESTAMPTZ DEFAULT NOW()
);


-- ══════════════════════════════════════════════════════════════
-- Table: watchlist_stocks
-- Each row is one stock on one user's watchlist, with
-- per-stock VaR configuration overrides.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS watchlist_stocks (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ticker                  TEXT NOT NULL,                  -- e.g., 'AAPL'
    company_name            TEXT,                           -- e.g., 'Apple Inc.'
    confidence_level        DECIMAL(4,3),                   -- per-stock override (NULL = use user default)
    time_horizon            TEXT,                           -- per-stock override
    calc_method             TEXT,                           -- per-stock override
    alert_direction         TEXT DEFAULT 'both',            -- 'down', 'up', 'both'
    simple_threshold_pct    DECIMAL(5,2),                   -- if set, use simple % alert instead of VaR
    alerts_enabled          BOOLEAN DEFAULT TRUE,
    cooldown_minutes        INTEGER DEFAULT 60,             -- alert cooldown period
    added_at                TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookups by user
CREATE INDEX IF NOT EXISTS idx_watchlist_user
    ON watchlist_stocks (user_id);

-- Index for finding all watchers of a given ticker (used by Python backend)
CREATE INDEX IF NOT EXISTS idx_watchlist_ticker
    ON watchlist_stocks (ticker);

-- Prevent duplicate ticker per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_user_ticker
    ON watchlist_stocks (user_id, ticker);


-- ══════════════════════════════════════════════════════════════
-- Table: price_history
-- Daily OHLCV data fetched from Polygon.io.
-- Shared table — not per-user. Written by the Python backend.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS price_history (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticker      TEXT NOT NULL,
    date        DATE NOT NULL,
    open        DECIMAL(12,4),
    high        DECIMAL(12,4),
    low         DECIMAL(12,4),
    close       DECIMAL(12,4),
    volume      BIGINT,
    adj_close   DECIMAL(12,4)
);

-- Primary lookup pattern: get recent prices for a ticker
CREATE UNIQUE INDEX IF NOT EXISTS idx_price_history_ticker_date
    ON price_history (ticker, date);

CREATE INDEX IF NOT EXISTS idx_price_history_ticker_date_desc
    ON price_history (ticker, date DESC);


-- ══════════════════════════════════════════════════════════════
-- Table: var_calculations
-- Per-user VaR calculation results (linked to watchlist entries).
-- This is the ORIGINAL on-device-style table from the design doc.
-- The Python backend uses var_calculations_precomputed (in 002)
-- instead, but this table is kept for any on-device calculations
-- the iOS app may still perform.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS var_calculations (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    watchlist_stock_id  UUID REFERENCES watchlist_stocks(id) ON DELETE CASCADE,
    calc_date           DATE NOT NULL,
    method              TEXT NOT NULL,                      -- 'historical', 'parametric', 'montecarlo'
    confidence_level    DECIMAL(4,3) NOT NULL,
    time_horizon        TEXT NOT NULL,                      -- '1d', '1w'
    var_lower           DECIMAL(12,4),                      -- lower VaR boundary (price)
    var_upper           DECIMAL(12,4),                      -- upper VaR boundary (price)
    var_pct_lower       DECIMAL(10,6),                      -- lower VaR as %
    var_pct_upper       DECIMAL(10,6),                      -- upper VaR as %
    reference_price     DECIMAL(12,4),                      -- base price for calculation
    computed_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_var_calc_watchlist
    ON var_calculations (watchlist_stock_id, calc_date DESC);


-- ══════════════════════════════════════════════════════════════
-- Table: alert_events
-- Log of every alert that has been triggered and sent to a user.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS alert_events (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    watchlist_stock_id  UUID REFERENCES watchlist_stocks(id) ON DELETE SET NULL,
    alert_type          TEXT NOT NULL,                      -- 'var_breach_down', 'var_breach_up',
                                                           -- 'earnings_reminder', 'earnings_result'
    ticker              TEXT NOT NULL,                      -- denormalised for fast queries
    price_at_alert      DECIMAL(12,4),
    var_lower           DECIMAL(12,4),                      -- VaR bounds at time of alert
    var_upper           DECIMAL(12,4),
    message             TEXT,                               -- notification body text
    is_read             BOOLEAN DEFAULT FALSE,
    triggered_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_events_user
    ON alert_events (user_id, triggered_at DESC);

CREATE INDEX IF NOT EXISTS idx_alert_events_user_unread
    ON alert_events (user_id, is_read) WHERE is_read = FALSE;


-- ══════════════════════════════════════════════════════════════
-- Table: earnings_calendar
-- Upcoming and past earnings dates for tracked stocks.
-- Written by the Python backend (daily sync from FMP / Finnhub).
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS earnings_calendar (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ticker              TEXT NOT NULL,
    earnings_date       DATE NOT NULL,
    is_confirmed        BOOLEAN DEFAULT FALSE,
    time_of_day         TEXT,                               -- 'bmo', 'amc', 'during'
    fiscal_quarter      TEXT,                               -- e.g., 'Q1 2026'
    consensus_eps       DECIMAL(10,4),
    consensus_revenue   DECIMAL(16,2),
    actual_eps          DECIMAL(10,4),                      -- filled post-report
    actual_revenue      DECIMAL(16,2),                      -- filled post-report
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_earnings_ticker_date
    ON earnings_calendar (ticker, earnings_date);

CREATE INDEX IF NOT EXISTS idx_earnings_date
    ON earnings_calendar (earnings_date);


-- ══════════════════════════════════════════════════════════════
-- Row Level Security (RLS) Policies
-- Each user can only access their own data.
-- Shared reference data (price_history, earnings_calendar) is
-- readable by everyone.
-- ══════════════════════════════════════════════════════════════

-- ── users ────────────────────────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_select_own" ON users
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "users_update_own" ON users
    FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "users_insert_own" ON users
    FOR INSERT WITH CHECK (auth.uid() = id);

-- ── watchlist_stocks ─────────────────────────────────────────
ALTER TABLE watchlist_stocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "watchlist_select_own" ON watchlist_stocks
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "watchlist_insert_own" ON watchlist_stocks
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "watchlist_update_own" ON watchlist_stocks
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "watchlist_delete_own" ON watchlist_stocks
    FOR DELETE USING (auth.uid() = user_id);

-- ── var_calculations ─────────────────────────────────────────
ALTER TABLE var_calculations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "var_calc_select_own" ON var_calculations
    FOR SELECT USING (
        watchlist_stock_id IN (
            SELECT id FROM watchlist_stocks WHERE user_id = auth.uid()
        )
    );

CREATE POLICY "var_calc_insert_own" ON var_calculations
    FOR INSERT WITH CHECK (
        watchlist_stock_id IN (
            SELECT id FROM watchlist_stocks WHERE user_id = auth.uid()
        )
    );

-- ── alert_events ─────────────────────────────────────────────
ALTER TABLE alert_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "alerts_select_own" ON alert_events
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "alerts_update_own" ON alert_events
    FOR UPDATE USING (auth.uid() = user_id);

-- ── price_history (public read, backend write) ───────────────
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "price_history_read_all" ON price_history
    FOR SELECT USING (TRUE);

-- ── earnings_calendar (public read, backend write) ───────────
ALTER TABLE earnings_calendar ENABLE ROW LEVEL SECURITY;

CREATE POLICY "earnings_read_all" ON earnings_calendar
    FOR SELECT USING (TRUE);


-- ══════════════════════════════════════════════════════════════
-- Helper function: auto-create a user profile row
-- when a new user signs up via Supabase Auth.
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    INSERT INTO public.users (id, email, display_name)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.email)
    );
    RETURN NEW;
END;
$$;

-- Trigger: fire on every new Supabase Auth signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ══════════════════════════════════════════════════════════════
-- Done! Run 002_var_precomputed_and_sp500.sql next.
-- ══════════════════════════════════════════════════════════════
