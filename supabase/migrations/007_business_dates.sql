-- ============================================================
-- StockPulse — 007_business_dates.sql
-- Phase 4a: distinct business-date table, tagged by calendar.
-- Run in Supabase SQL Editor AFTER 006.
-- ============================================================
--
-- WHY THIS TABLE EXISTS
-- ---------------------
-- Today the iOS VaR engine derives "what are the business dates?" implicitly
-- from `SELECT DISTINCT business_date FROM price_history`. This works as long
-- as every ticker trades on the same calendar (NYSE/Nasdaq).
--
-- The moment a non-US ticker is added, the implicit approach breaks: a UK
-- stock's Boxing Day (Dec 26) has no NYSE price row, and a US Thanksgiving
-- has no LSE price row — the two sets only partially overlap, and the
-- engine iterates the union, producing nonsense VaR on mismatched days.
--
-- `business_dates` is the explicit source of truth, tagged per calendar.
-- Today only `'US'` is seeded. When the app adds its first LSE ticker,
-- insert `('UK', <date>)` rows and point that ticker's Stock.calendar_code
-- to `'UK'` — no schema change required.
--
-- This migration is pure infrastructure: it does not change any runtime
-- behavior today. Phase 4b will thread the calendar through the VaR engine.

-- ══════════════════════════════════════════════════════════════
-- Table: business_dates
-- Two columns, composite PK. That's it.
-- ══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS business_dates (
    calendar_code  TEXT  NOT NULL DEFAULT 'US',
    business_date  DATE  NOT NULL,

    CONSTRAINT business_dates_pkey
        PRIMARY KEY (calendar_code, business_date)
);

-- Secondary index for the common "give me all dates for US since X" query
CREATE INDEX IF NOT EXISTS idx_business_dates_code_date_desc
    ON business_dates (calendar_code, business_date DESC);

-- ══════════════════════════════════════════════════════════════
-- Seed: every distinct business_date currently in price_history
-- becomes a US business date. Uses ON CONFLICT so re-running is safe.
-- ══════════════════════════════════════════════════════════════

INSERT INTO business_dates (calendar_code, business_date)
SELECT DISTINCT 'US', business_date
FROM price_history
ON CONFLICT (calendar_code, business_date) DO NOTHING;

-- ══════════════════════════════════════════════════════════════
-- RLS: public read (same pattern as price_history, global_correlations,
-- stock_volatility). Backend writes via service role key (bypasses RLS).
-- ══════════════════════════════════════════════════════════════

ALTER TABLE business_dates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "business_dates_read_all" ON business_dates
    FOR SELECT USING (TRUE);

-- ══════════════════════════════════════════════════════════════
-- Extend sp500_constituents with calendar_code.
--
-- Plain TEXT column, no foreign key. Keeping it unconstrained means you can
-- add rows tagged with new calendar codes before seeding `business_dates`
-- for that calendar — no chicken-and-egg ordering problem during setup.
-- Every existing row defaults to 'US'.
-- ══════════════════════════════════════════════════════════════

ALTER TABLE sp500_constituents
    ADD COLUMN IF NOT EXISTS calendar_code TEXT NOT NULL DEFAULT 'US';

-- Backfill safety: any pre-existing rows get 'US' (the DEFAULT covers new
-- inserts, but a belt-and-braces UPDATE handles any rows that somehow
-- arrived with NULL before the column was added).
UPDATE sp500_constituents
SET calendar_code = 'US'
WHERE calendar_code IS NULL;

-- ══════════════════════════════════════════════════════════════
-- Done. No RPCs, no helper functions — iOS fetches business_dates
-- with a plain PostgREST GET. Keep it simple until we need more.
-- ══════════════════════════════════════════════════════════════
