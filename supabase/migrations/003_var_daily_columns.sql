-- ============================================================
-- StockPulse — 003_var_daily_columns.sql
-- Add rolling daily VaR columns to var_calculations_precomputed.
-- Run in Supabase SQL Editor AFTER 002.
-- ============================================================

-- Daily simple return for this date
ALTER TABLE var_calculations_precomputed
    ADD COLUMN IF NOT EXISTS daily_return DECIMAL(10,6);

-- Breach flags: did the actual return exceed VaR?
ALTER TABLE var_calculations_precomputed
    ADD COLUMN IF NOT EXISTS breach_lower BOOLEAN;

ALTER TABLE var_calculations_precomputed
    ADD COLUMN IF NOT EXISTS breach_upper BOOLEAN;
