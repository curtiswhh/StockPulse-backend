"""
Configuration — settings for StockPulse VaR pipeline.
========================================================

SEED_TICKERS vs PRICE_HISTORY:
  seed_tickers is a convenience list for standalone testing and cold-start
  seeding only. It is NOT used by the daily pipeline or any CLI command.

  The daily pipeline and all "--all" CLI commands resolve tickers by
  querying SELECT DISTINCT ticker FROM price_history in Supabase.
  If a ticker has price data, it gets processed automatically.

  You can use seed_tickers for quick local testing like:
    for t in settings.seed_tickers:
        await backfill.fetch_and_compute_var(t)

TEST_MODE vs PRODUCTION:
  TEST_MODE=true  → daily pipeline processes only tickers in price_history
  TEST_MODE=false → daily pipeline merges price_history + all active S&P 500
                     (so newly added S&P 500 stocks get backfilled automatically)
"""

import os
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass


@dataclass
class Settings:
    # ── Supabase ──────────────────────────────────────────────
    supabase_url: str = field(default_factory=lambda: os.environ["SUPABASE_URL"])
    supabase_service_key: str = field(
        default_factory=lambda: os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    )

    # ── Polygon.io (fallback — optional if using yfinance as primary) ──
    polygon_api_key: str = field(
        default_factory=lambda: os.environ.get("POLYGON_API_KEY", "")
    )

    # ══════════════════════════════════════════════════════════
    # TEST / PRODUCTION MODE
    # ══════════════════════════════════════════════════════════
    test_mode: bool = field(
        default_factory=lambda: os.environ.get("TEST_MODE", "true").lower() == "true"
    )

    # Convenience list for standalone testing / cold-start seeding.
    # NOT used by the daily pipeline or CLI commands.
    # The pipeline resolves tickers from price_history instead.
    seed_tickers: tuple = ("AAPL", "TSLA")

    # ── VaR Parameters ────────────────────────────────────────
    # Simple percentile VaR settings
    var_confidence_level: float = 0.95          # single confidence level
    var_lookback_days: int = 252                # 1-year rolling lookback
    var_max_backfill_days: int = 1000           # fetch 1000 days of price data

    # ── Pipeline Tuning ───────────────────────────────────────
    polygon_rate_limit_per_min: int = 5
    polygon_batch_size: int = 5
    price_fetch_delay_sec: float = 12.5

    # ── Correlation Parameters ─────────────────────────────────
    correlation_lookback_periods: tuple = (90,)   # 90-day and 1-year
    correlation_min_overlap_pct: float = 0.8          # require 80% date overlap

    # ── S&P 500 Source ────────────────────────────────────────
    sp500_wikipedia_url: str = (
        "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
    )

    def describe(self) -> str:
        mode = "TEST" if self.test_mode else "PRODUCTION"
        return (
            f"── Settings ({mode} MODE) ──\n"
            f"  Mode:               {mode}\n"
            f"  Seed tickers:       {list(self.seed_tickers)} (for standalone testing only)\n"
            f"  Ticker resolution:  All distinct tickers in price_history\n"
            f"  Backfill days:      {self.var_max_backfill_days}\n"
            f"  VaR confidence:     {self.var_confidence_level}\n"
            f"  VaR lookback:       {self.var_lookback_days} trading days\n"
            f"  Correlation periods: {list(self.correlation_lookback_periods)} days\n"
            f"  Correlation overlap: {self.correlation_min_overlap_pct:.0%}\n"
        )


def safe_fetch_date() -> date:
    """
    Return the latest date we can safely fetch closing prices for.

    If US market is still open (before 4:00 PM ET on a weekday),
    returns yesterday so we don't write incomplete intraday bars
    into price_history. After market close, returns today.

    Weekend/holiday: returns today (markets are closed, yfinance
    won't return a bar for a non-trading day anyway).
    """
    et_now = datetime.now(ZoneInfo("America/New_York"))
    is_weekday = et_now.weekday() < 5  # Mon=0 .. Fri=4
    market_closed = et_now.hour >= 16   # 4:00 PM ET

    if is_weekday and not market_closed:
        return date.today() - timedelta(days=1)

    return date.today()