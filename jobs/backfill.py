"""
Backfill Job — Polygon fetch and VaR computation.
========================================================

METHOD NAMING CONVENTION:
  fetch_and_compute_var_*  → calls Polygon API for prices, THEN computes returns/vol/corr/VaR
  compute_var_*            → computes metrics ONLY from existing Supabase data (NO Polygon)

TICKER RESOLUTION:
  Methods ending in "_all" resolve tickers by querying all distinct tickers
  in the stock_price table. This means any ticker you've uploaded price
  data for will automatically be included — no config changes needed.

  The seed_tickers in settings.py are NOT used here. They exist only for
  standalone testing / cold-start seeding and are separate from these commands.
"""

import logging
from datetime import timedelta

from config.settings import Settings, safe_fetch_date
from services.supabase_client import SupabaseClient
from services.var_engine import VaREngine

logger = logging.getLogger(__name__)


class BackfillJob:
    def __init__(
        self,
        supabase,
        price_client,
        var_engine,
        settings,
        correlation_engine=None,
        volatility_engine=None,
        return_engine=None,
    ):
        self.supabase = supabase
        self.price_client = price_client
        self.var_engine = var_engine
        self.settings = settings
        self.correlation_engine = correlation_engine
        self.volatility_engine = volatility_engine
        self.return_engine = return_engine

    # ══════════════════════════════════════════════════════════
    # FETCH + COMPUTE VAR (fetches price data via yfinance/Polygon)
    # ══════════════════════════════════════════════════════════

    async def fetch_and_compute_var(self, ticker: str):
        """
        Fetch prices + compute returns + vol + VaR for ONE ticker.
        CLI: python main.py --fetch-and-compute-var TSLA

        Steps:
          1. Fetch ~1000 days of daily bars (yfinance → Polygon fallback)
          2. Upsert into stock_price in Supabase
          3. Read back full price history from Supabase
          4. Compute rolling daily returns + vol + VaR
          5. Upsert results into stock_return / stock_volatility / stock_var
        """
        logger.info(f"[fetch-and-compute-var] {ticker}: starting...")
        today = safe_fetch_date()
        earliest_needed = today - timedelta(days=self.settings.var_max_backfill_days + 30)
        latest_in_db = self.supabase.get_latest_price_date(ticker)

        if latest_in_db and latest_in_db >= today - timedelta(days=5):
            from_date = latest_in_db + timedelta(days=1)
            logger.info(f"  {ticker}: filling gap from {from_date}")
        else:
            from_date = earliest_needed
            logger.info(f"  {ticker}: full fetch from {from_date}")

        # ── Step 1: Fetch price data in yearly chunks ────────────
        current_start = from_date
        all_bars: list[dict] = []
        while current_start <= today:
            chunk_end = min(current_start + timedelta(days=365), today)
            bars = await self.price_client.get_daily_bars(ticker, current_start, chunk_end)
            all_bars.extend(bars)
            current_start = chunk_end + timedelta(days=1)

        # ── Step 2: Upsert price data ──
        if all_bars:
            self.supabase.upsert_price_history(all_bars)
            logger.info(f"  {ticker}: loaded {len(all_bars)} daily bars")

            seen_dates = {bar.get("business_date") for bar in all_bars if bar.get("business_date") is not None}
            if seen_dates:
                self.supabase.upsert_business_dates(sorted(seen_dates), calendar_code="US")
        else:
            logger.warning(f"  {ticker}: no data returned from any source")
            return

        # ── Steps 3-5: Compute and store metrics ──
        await self.compute_var(ticker)

    async def fetch_and_compute_var_all(self):
        """
        Fetch prices from Polygon + compute returns + vol + VaR for ALL
        tickers in stock_price.
        CLI: python main.py --fetch-and-compute-var-all
        """
        tickers = self.supabase.get_all_price_history_tickers()
        logger.info(f"[fetch-and-compute-var-all] Processing {len(tickers)} tickers from stock_price: {tickers}")

        for i, ticker in enumerate(tickers):
            logger.info(f"[{i+1}/{len(tickers)}] {ticker}")
            await self.fetch_and_compute_var(ticker)

        logger.info(f"Fetch + VaR complete — {len(tickers)} tickers processed.")

    # ══════════════════════════════════════════════════════════
    # COMPUTE ONLY (NO Polygon calls)
    # Order: return → vol → VaR (single-ticker; corr is cross-ticker)
    # ══════════════════════════════════════════════════════════

    async def compute_var(self, ticker: str):
        """
        Compute returns + vol + VaR for ONE ticker from existing Supabase
        price data.
        CLI: python main.py --compute-var TSLA

        No Polygon calls — works purely from data already in stock_price.
        Use this after you've manually uploaded prices to Supabase.
        """
        logger.info(f"[compute-var] {ticker}: computing returns + vol + VaR...")

        prices = self.supabase.get_full_price_history(ticker)

        # ── Returns: only need ≥2 prices ──
        if self.return_engine is not None and len(prices) >= 2:
            return_rows = self.return_engine.compute_daily_returns(ticker=ticker, prices=prices)
            if return_rows:
                self.supabase.upsert_stock_returns(return_rows)
                logger.info(f"  {ticker}: upserted {len(return_rows)} return rows")

        if len(prices) < self.settings.var_lookback_days + 2:
            logger.warning(
                f"  {ticker}: insufficient data for VaR "
                f"({len(prices)} rows, need {self.settings.var_lookback_days + 2})"
            )
            return

        # ── Volatility ──
        if self.volatility_engine is not None:
            vol_rows = self.volatility_engine.compute_rolling_volatility(
                ticker=ticker,
                prices=prices,
                lookback_days=self.settings.var_lookback_days,
            )
            if vol_rows:
                self.supabase.upsert_stock_volatility(vol_rows)
                logger.info(f"  {ticker}: upserted {len(vol_rows)} volatility rows")

        # ── VaR ──
        var_rows = self.var_engine.compute_rolling_var(
            ticker=ticker,
            prices=prices,
            confidence_level=self.settings.var_confidence_level,
            lookback_days=self.settings.var_lookback_days,
        )
        if var_rows:
            self.supabase.upsert_var_calculations(var_rows)
            logger.info(f"  {ticker}: upserted {len(var_rows)} VaR rows")

    async def compute_var_all(self):
        """
        Compute returns + vol + VaR for ALL tickers that have price data
        in Supabase.
        CLI: python main.py --compute-var-all
        """
        tickers = self.supabase.get_all_price_history_tickers()
        logger.info(f"[compute-var-all] Processing {len(tickers)} tickers from stock_price: {tickers}")

        for i, ticker in enumerate(tickers):
            logger.info(f"[{i+1}/{len(tickers)}] {ticker}")
            await self.compute_var(ticker)

        logger.info(f"VaR computation complete — {len(tickers)} tickers processed.")

    # ══════════════════════════════════════════════════════════
    # COMPUTE RETURNS ONLY (NO Polygon calls)
    # ══════════════════════════════════════════════════════════

    async def compute_returns_all(self):
        """
        Compute daily returns for ALL tickers in stock_price.
        CLI: python main.py --compute-returns-all

        No Polygon calls — works purely from existing data.
        """
        if self.return_engine is None:
            logger.error("ReturnEngine not provided — cannot compute returns")
            return

        tickers = self.supabase.get_all_price_history_tickers()
        logger.info(f"[compute-returns-all] Processing {len(tickers)} tickers from stock_price: {tickers}")

        for i, ticker in enumerate(tickers):
            logger.info(f"[{i+1}/{len(tickers)}] {ticker}")
            prices = self.supabase.get_full_price_history(ticker)

            if len(prices) < 2:
                logger.warning(f"  {ticker}: only {len(prices)} prices — skipping returns")
                continue

            rows = self.return_engine.compute_daily_returns(ticker=ticker, prices=prices)
            if rows:
                self.supabase.upsert_stock_returns(rows)

        logger.info(f"Return computation complete — {len(tickers)} tickers processed.")

    # ══════════════════════════════════════════════════════════
    # COMPUTE VOLATILITY ONLY (NO Polygon calls)
    # ══════════════════════════════════════════════════════════

    async def compute_volatility_all(self):
        """
        Compute rolling volatility for ALL tickers in stock_price.
        CLI: python main.py --compute-volatility-all
        """
        if self.volatility_engine is None:
            logger.error("VolatilityEngine not provided — cannot compute volatility")
            return

        tickers = self.supabase.get_all_price_history_tickers()
        logger.info(f"[compute-volatility-all] Processing {len(tickers)} tickers from stock_price: {tickers}")

        for i, ticker in enumerate(tickers):
            logger.info(f"[{i+1}/{len(tickers)}] {ticker}")
            prices = self.supabase.get_full_price_history(ticker)

            if len(prices) < self.settings.var_lookback_days + 2:
                logger.warning(
                    f"  {ticker}: insufficient data for volatility "
                    f"({len(prices)} rows, need {self.settings.var_lookback_days + 2})"
                )
                continue

            vol_rows = self.volatility_engine.compute_rolling_volatility(
                ticker=ticker,
                prices=prices,
                lookback_days=self.settings.var_lookback_days,
            )
            if vol_rows:
                self.supabase.upsert_stock_volatility(vol_rows)

        logger.info(f"Volatility computation complete — {len(tickers)} tickers processed.")

    # ══════════════════════════════════════════════════════════
    # COMPUTE CORRELATIONS ONLY (NO Polygon calls)
    # ══════════════════════════════════════════════════════════

    async def compute_correlations_all(self):
        """
        Compute rolling pairwise correlations for ALL tickers in stock_price.
        CLI: python main.py --compute-correlations-all
        """
        if self.correlation_engine is None:
            logger.error("CorrelationEngine not provided — cannot compute correlations")
            return

        tickers = self.supabase.get_all_price_history_tickers()
        logger.info(f"[compute-correlations-all] Processing {len(tickers)} tickers from stock_price: {tickers}")

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
                logger.info(f"  {ticker}: only {len(prices)} prices — skipping (need {min_prices_needed})")

        logger.info(f"  {len(all_prices)} tickers have sufficient data")

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

        logger.info(f"Correlation computation complete — {len(all_prices)} tickers processed.")

    # ══════════════════════════════════════════════════════════
    # INDICES (yfinance scrape → yf_index_price / yf_index_return)
    # Driven by the yf_index_list table (gold source: config/index_list.py)
    # ══════════════════════════════════════════════════════════

    async def fetch_and_compute_index(self, ticker: str):
        """Fetch prices + compute returns for ONE index symbol (e.g. '^GSPC')."""
        logger.info(f"[fetch-and-compute-index] {ticker}: starting...")
        today = safe_fetch_date()
        earliest_needed = today - timedelta(days=self.settings.var_max_backfill_days + 30)
        latest_in_db = self.supabase.get_latest_index_price_date(ticker)

        if latest_in_db and latest_in_db >= today - timedelta(days=5):
            from_date = latest_in_db + timedelta(days=1)
            logger.info(f"  {ticker}: filling gap from {from_date}")
        else:
            from_date = earliest_needed
            logger.info(f"  {ticker}: full fetch from {from_date}")

        current_start = from_date
        all_bars: list[dict] = []
        while current_start <= today:
            chunk_end = min(current_start + timedelta(days=365), today)
            bars = await self.price_client.get_daily_bars(ticker, current_start, chunk_end)
            all_bars.extend(bars)
            current_start = chunk_end + timedelta(days=1)

        if not all_bars:
            logger.warning(f"  {ticker}: no data returned from any source")
            return
        self.supabase.upsert_index_price(all_bars)
        logger.info(f"  {ticker}: loaded {len(all_bars)} daily bars")

        await self.compute_index_returns(ticker)

    async def fetch_and_compute_index_all(self):
        """Fetch prices + compute returns for ALL active symbols in yf_index_list.
        CLI: python main.py --fetch-and-compute-index-all"""
        symbols = self.supabase.get_active_index_symbols()
        logger.info(f"[fetch-and-compute-index-all] Processing {len(symbols)} indices: {symbols}")
        for i, symbol in enumerate(symbols):
            logger.info(f"[{i+1}/{len(symbols)}] {symbol}")
            await self.fetch_and_compute_index(symbol)
        logger.info(f"Index fetch + returns complete — {len(symbols)} indices processed.")

    async def compute_index_returns(self, ticker: str):
        """Compute daily returns for ONE index from existing yf_index_price data."""
        if self.return_engine is None:
            logger.error("ReturnEngine not provided — cannot compute index returns")
            return
        prices = self.supabase.get_full_index_price_history(ticker)
        if len(prices) < 2:
            logger.warning(f"  {ticker}: only {len(prices)} prices — skipping returns")
            return
        rows = self.return_engine.compute_daily_returns(ticker=ticker, prices=prices)
        if rows:
            self.supabase.upsert_index_returns(rows)
            logger.info(f"  {ticker}: upserted {len(rows)} yf_index_return rows")

    async def compute_index_returns_all(self):
        """Compute daily returns for ALL active indices from existing data.
        CLI: python main.py --compute-index-returns-all"""
        symbols = self.supabase.get_active_index_symbols()
        logger.info(f"[compute-index-returns-all] Processing {len(symbols)} indices: {symbols}")
        for i, symbol in enumerate(symbols):
            logger.info(f"[{i+1}/{len(symbols)}] {symbol}")
            await self.compute_index_returns(symbol)
        logger.info(f"Index return computation complete — {len(symbols)} indices processed.")