"""
Daily Pipeline — runs as the GitHub Actions cron job.
========================================================

TICKER RESOLUTION (how the pipeline decides which stocks to process):
  1. Query Supabase for all distinct tickers in stock_price
  2. That's the list. Every ticker with price data gets processed.

  In PRODUCTION mode, S&P 500 tickers from sp500_constituents are also
  merged in, so newly added S&P 500 stocks get backfilled automatically.

  The seed_tickers in settings.py are NOT used by the daily pipeline.
  They exist only for standalone testing / cold-start seeding.

WHAT THE PIPELINE DOES FOR EACH TICKER:
  Step 1: Refresh S&P 500 constituent list (non-fatal if it fails)
  Step 2: Resolve tickers (from stock_price + S&P 500 in production)
  Step 3: Backfill any ticker with no price data yet (full Polygon fetch)
  Step 4: Fetch latest 5 days of prices from Polygon (keeps data current)
  Step 5: Compute daily returns and upsert to stock_return
  Step 6: Compute rolling VaR and upsert to stock_var
  Step 7: Compute rolling per-stock volatility and upsert to stock_volatility
  Step 8: Compute rolling pairwise correlations and upsert to stock_correlation
  Step 9: Sync yf_index_list from config/index_list.py, then scrape index prices
          and returns into yf_index_price / yf_index_return (runs in TEST + PRODUCTION)
"""

import logging
from datetime import date, timedelta

from config.settings import Settings, safe_fetch_date
from services.supabase_client import SupabaseClient
from services.price_data_client import PriceDataClient
from services.sp500_tracker import SP500Tracker
from services.index_tracker import IndexTracker
from services.var_engine import VaREngine
from services.correlation_engine import CorrelationEngine
from services.volatility_engine import VolatilityEngine
from services.return_engine import ReturnEngine
from jobs.backfill import BackfillJob

logger = logging.getLogger(__name__)


class DailyPipeline:
    def __init__(
        self,
        settings: Settings,
        supabase: SupabaseClient,
        price_client: PriceDataClient,
        sp500_tracker: SP500Tracker,
        var_engine: VaREngine,
        correlation_engine: CorrelationEngine,
        volatility_engine: VolatilityEngine | None = None,
        return_engine: ReturnEngine | None = None,
    ):
        self.settings = settings
        self.supabase = supabase
        self.price_client = price_client
        self.sp500 = sp500_tracker
        self.var_engine = var_engine
        self.correlation_engine = correlation_engine
        self.volatility_engine = volatility_engine or VolatilityEngine()
        self.return_engine = return_engine or ReturnEngine()

    async def run(self):
        today = date.today()
        fetch_date = safe_fetch_date()
        mode = "TEST" if self.settings.test_mode else "PRODUCTION"
        logger.info(f"═══ Daily Pipeline ({mode} MODE) — {today.isoformat()} ═══")
        if fetch_date < today:
            logger.info(f"  ⚠ Market still open — fetch date capped to {fetch_date}")
        else:
            logger.info(f"  Fetch date: {fetch_date}")
        logger.info(self.settings.describe())

        # ── Step 1: Refresh S&P 500 list ──────────────────────
        logger.info("Step 1/9: Refreshing S&P 500 constituents...")
        try:
            diff = await self.sp500.refresh()
        except Exception as e:
            logger.warning(f"  S&P 500 refresh failed (non-fatal): {e}")
            diff = {"added": [], "removed": [], "total": 0}

        # ── Step 2: Resolve which tickers to process ──────────
        tickers = self._resolve_tickers()
        logger.info(f"Step 2/9: Processing {len(tickers)} tickers: {tickers[:10]}{'...' if len(tickers) > 10 else ''}")

        # ── Step 3: Backfill any tickers missing data ─────────
        logger.info("Step 3/9: Checking for tickers that need backfill...")
        backfill = BackfillJob(
            supabase=self.supabase,
            price_client=self.price_client,
            var_engine=self.var_engine,
            settings=self.settings,
            volatility_engine=self.volatility_engine,
            return_engine=self.return_engine,
        )
        for ticker in tickers:
            latest = self.supabase.get_latest_price_date(ticker)
            if latest is None:
                logger.info(f"  {ticker}: no data found, running full backfill...")
                await backfill.fetch_and_compute_var(ticker)

        # ── Step 4: Fetch latest prices ────────────────────────
        logger.info(f"Step 4/9: Fetching latest closing prices for {len(tickers)} tickers (up to {fetch_date})...")
        await self._fetch_daily_prices(tickers, fetch_date)

        # ── Step 5: Compute daily returns ──────────────────────
        logger.info(f"Step 5/9: Computing daily returns for {len(tickers)} tickers...")
        self._compute_returns_all(tickers)

        # ── Step 6: Compute VaR ───────────────────────────────
        logger.info(f"Step 6/9: Computing VaR for {len(tickers)} tickers...")
        await self._compute_var_all(tickers)

        # ── Step 7: Compute per-stock volatility ──────────────
        logger.info(f"Step 7/9: Computing per-stock volatility for {len(tickers)} tickers...")
        self._compute_volatility_all(tickers)

        # ── Step 8: Compute pairwise correlations ─────────────
        logger.info(f"Step 8/9: Computing pairwise correlations for {len(tickers)} tickers...")
        self._compute_correlations(tickers)

        # ── Step 9: Indices (sync list → scrape price + returns) ──
        logger.info("Step 9/9: Syncing yf_index_list and scraping index prices/returns...")
        await self._run_indices()

        logger.info(f"═══ Daily Pipeline Complete ({mode} MODE) ═══")

    # ── Core Logic ────────────────────────────────────────────

    def _resolve_tickers(self) -> list[str]:
        """
        Build the combined ticker list for the daily pipeline.

        Resolution logic:
          1. Always include all distinct tickers from stock_price
             (this is the primary source — if it has price data, we process it)
          2. In PRODUCTION mode, also merge in active S&P 500 tickers
             (so newly added S&P 500 stocks get picked up for backfill)
          3. Return deduplicated, sorted list
        """
        existing_in_db = set(self.supabase.get_all_price_history_tickers())
        logger.info(f"  Tickers in stock_price: {sorted(existing_in_db)}")

        if not self.settings.test_mode:
            sp500_tickers = set(self.sp500.get_active_tickers())
            logger.info(f"  PRODUCTION MODE: merging {len(sp500_tickers)} S&P 500 tickers")
            combined = sorted(existing_in_db | sp500_tickers)
        else:
            logger.info(f"  TEST MODE: using stock_price tickers only")
            combined = sorted(existing_in_db)

        logger.info(f"  Final ticker list ({len(combined)}): {combined[:15]}{'...' if len(combined) > 15 else ''}")
        return combined

    async def _fetch_daily_prices(self, tickers: list[str], today: date):
        """Fetch the last 5 days of prices for each ticker (yfinance → Polygon fallback)."""
        from_date = today - timedelta(days=5)
        seen_business_dates: set = set()

        for i, ticker in enumerate(tickers):
            logger.info(f"  [{i+1}/{len(tickers)}] Fetching prices for {ticker}...")
            bars = await self.price_client.get_daily_bars(ticker, from_date, today)
            if bars:
                self.supabase.upsert_price_history(bars)
                for bar in bars:
                    bd = bar.get("business_date")
                    if bd is not None:
                        seen_business_dates.add(bd)

        if seen_business_dates:
            self.supabase.upsert_business_dates(
                sorted(seen_business_dates), calendar_code="US"
            )

    def _compute_returns_all(self, tickers: list[str]):
        """Compute daily returns for each ticker and upsert to stock_return."""
        for i, ticker in enumerate(tickers):
            logger.info(f"  [{i+1}/{len(tickers)}] Computing returns for {ticker}...")
            prices = self.supabase.get_full_price_history(ticker)

            if len(prices) < 2:
                logger.warning(f"  {ticker}: only {len(prices)} prices — skipping returns")
                continue

            rows = self.return_engine.compute_daily_returns(ticker=ticker, prices=prices)
            if rows:
                self.supabase.upsert_stock_returns(rows)

    async def _compute_var_all(self, tickers: list[str]):
        """Compute rolling VaR for each ticker and upsert to stock_var."""
        for i, ticker in enumerate(tickers):
            logger.info(f"  [{i+1}/{len(tickers)}] Computing VaR for {ticker}...")
            prices = self.supabase.get_full_price_history(ticker)

            if len(prices) < self.settings.var_lookback_days + 2:
                logger.warning(f"  {ticker}: only {len(prices)} prices — skipping VaR (need {self.settings.var_lookback_days + 2})")
                continue

            var_rows = self.var_engine.compute_rolling_var(
                ticker=ticker,
                prices=prices,
                confidence_level=self.settings.var_confidence_level,
                lookback_days=self.settings.var_lookback_days,
            )
            if var_rows:
                self.supabase.upsert_var_calculations(var_rows)

    def _compute_volatility_all(self, tickers: list[str]):
        """Compute rolling daily volatility for each ticker and upsert to stock_volatility."""
        for i, ticker in enumerate(tickers):
            logger.info(f"  [{i+1}/{len(tickers)}] Computing volatility for {ticker}...")
            prices = self.supabase.get_full_price_history(ticker)

            if len(prices) < self.settings.var_lookback_days + 2:
                logger.warning(f"  {ticker}: only {len(prices)} prices — skipping vol (need {self.settings.var_lookback_days + 2})")
                continue

            vol_rows = self.volatility_engine.compute_rolling_volatility(
                ticker=ticker,
                prices=prices,
                lookback_days=self.settings.var_lookback_days,
            )
            if vol_rows:
                self.supabase.upsert_stock_volatility(vol_rows)

    def _compute_correlations(self, tickers: list[str]):
        """
        Fetch all price histories, compute rolling pairwise correlations
        for each lookback period, and upsert to stock_correlation.

        Unlike VaR (which is per-ticker), correlations are cross-ticker:
        we need all price histories loaded together so we can pair them.
        """
        min_prices_needed = int(
            min(self.settings.correlation_lookback_periods)
            * self.settings.correlation_min_overlap_pct
        ) + 2

        all_prices: dict[str, list[dict]] = {}
        for ticker in tickers:
            prices = self.supabase.get_full_price_history(ticker)
            if len(prices) >= min_prices_needed:
                all_prices[ticker] = prices
            else:
                logger.info(
                    f"  {ticker}: only {len(prices)} prices — "
                    f"skipping correlations (need {min_prices_needed})"
                )

        logger.info(f"  {len(all_prices)} tickers have sufficient data for correlations")

        if len(all_prices) < 2:
            logger.warning("  Not enough tickers for pairwise correlations — skipping")
            return

        for period in self.settings.correlation_lookback_periods:
            logger.info(f"  Computing {period}-day rolling correlations...")
            corr_rows = self.correlation_engine.compute_rolling_correlations(
                all_prices=all_prices,
                period_days=period,
                min_overlap_pct=self.settings.correlation_min_overlap_pct,
            )
            if corr_rows:
                self.supabase.upsert_global_correlations(corr_rows)

    async def _run_indices(self):
        """Sync yf_index_list from the repo file, then scrape price + returns
        for every active index. Runs in both TEST and PRODUCTION mode."""
        from jobs.backfill import BackfillJob

        IndexTracker(self.supabase).sync()
        symbols = self.supabase.get_active_index_symbols()
        logger.info(f"  Processing {len(symbols)} active indices: {symbols}")

        backfill = BackfillJob(
            supabase=self.supabase,
            price_client=self.price_client,
            var_engine=self.var_engine,
            settings=self.settings,
            return_engine=self.return_engine,
        )
        for symbol in symbols:
            await backfill.fetch_and_compute_index(symbol)