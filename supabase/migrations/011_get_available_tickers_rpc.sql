-- 011_get_available_tickers_rpc.sql
-- Creates the RPC `get_available_tickers()` that iOS already tries to call
-- from `SupabaseService.fetchAvailableTickers`.
--
-- Returns the set of tickers that have actual rows in stock_price — i.e.
-- the *real* covered universe iOS uses for routing decisions in
-- StockHistoryProvider (covered → PriceHistoryCache; uncovered → /aggregates).
--
-- Before this migration, iOS fell through to a fallback that read
-- `sp500_constituents WHERE is_active = true`. That returns S&P 500
-- *membership*, which is broader than data presence — newly-added names,
-- pipeline gaps, and one-off backfilled tickers drift between the two sets
-- and surface as "stock detail empty / sparkline flat" for tickers the
-- classifier insists are covered.
--
-- After this migration, the classifier reflects the user's mental model
-- of "off-universe": a ticker is covered iff stock_price has at least one
-- non-null close for it.
--
-- STABLE: no writes. Lets the planner cache. SECURITY DEFINER not needed —
-- the anon role already has SELECT on stock_price for the iOS REST queries.
--
-- Cost: scans stock_price on every call. iOS calls this once per cold start
-- and caches the result for 7 days (CachePolicy.staticReference) in
-- UserDefaults, so call frequency is essentially zero. If scanning becomes
-- a problem later, we can add an index on (ticker) WHERE close IS NOT NULL,
-- but with a few hundred distinct tickers and a B-tree on (ticker, business_date)
-- already in place, today's table size doesn't warrant it.

CREATE OR REPLACE FUNCTION get_available_tickers()
RETURNS TABLE (ticker text)
LANGUAGE sql
STABLE
AS $$
    SELECT DISTINCT ticker
    FROM stock_price
    WHERE close IS NOT NULL
    ORDER BY ticker
$$;

-- Grant execute to the anon role so iOS can call this without a JWT, matching
-- the rest of the read-side surface (the existing `fetchAvailableTickers`
-- iOS path uses the anon key).
GRANT EXECUTE ON FUNCTION get_available_tickers() TO anon, authenticated;

-- Smoke test (run manually in the SQL editor to verify before pushing):
--   SELECT count(*) FROM get_available_tickers();
--   SELECT * FROM get_available_tickers() LIMIT 10;
-- Expect: count > 0; a sorted list of tickers from stock_price.
