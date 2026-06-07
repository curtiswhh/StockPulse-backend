"""
StockPulse Backend — Entry Point
========================================================

CLI COMMANDS (quick reference):
─────────────────────────────────────────────────────────────────────────────
  python main.py --run-daily                     ← Full daily pipeline (Polygon fetch + returns + VaR + vol + correlations) for all tickers
  python main.py --fetch-and-compute-var TSLA    ← Polygon fetch + returns + VaR + vol for ONE ticker
  python main.py --fetch-and-compute-var-all     ← Polygon fetch + returns + VaR + vol for ALL tickers in stock_price
  python main.py --compute-var TSLA              ← Returns + VaR + vol only for ONE ticker (NO Polygon calls)
  python main.py --compute-var-all               ← Returns + VaR + vol only for ALL tickers in stock_price (NO Polygon calls)
  python main.py --compute-returns-all           ← Daily returns only for ALL tickers (NO Polygon calls)
  python main.py --compute-correlations-all      ← Correlations only for ALL tickers (NO Polygon calls)
  python main.py --compute-volatility-all        ← Per-stock volatility only for ALL tickers (NO Polygon calls)
  python main.py --fetch-and-compute-index-all   ← Scrape Yahoo + compute returns for ALL active indices in index_list
  python main.py --compute-index-returns-all     ← Index returns only from existing index_price (no scrape)
  python main.py --refresh-sp500                 ← Refresh S&P 500 constituent list only
  python main.py --describe                      ← Print current config and exit
─────────────────────────────────────────────────────────────────────────────

TICKER RESOLUTION:
  All commands that process "all tickers" resolve them by querying
  SELECT DISTINCT ticker FROM stock_price in Supabase.

POLYGON API:
  Commands with "fetch" in the name call Polygon for price data.
  Commands without "fetch" work purely from existing Supabase data.
"""

import argparse
import asyncio
import logging

from config.settings import Settings
from services.supabase_client import SupabaseClient
from services.price_data_client import PriceDataClient
from services.sp500_tracker import SP500Tracker
from services.var_engine import VaREngine
from services.correlation_engine import CorrelationEngine
from services.volatility_engine import VolatilityEngine
from services.return_engine import ReturnEngine
from jobs.daily_pipeline import DailyPipeline
from jobs.backfill import BackfillJob

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("stockpulse")


async def main():
    parser = argparse.ArgumentParser(
        description="StockPulse VaR Pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
            Examples:
            python main.py --run-daily                     # Daily cron job
            python main.py --fetch-and-compute-var TSLA    # Add a new ticker end-to-end
            python main.py --compute-var TSLA              # Recompute after manual price upload
            python main.py --compute-var-all               # Recompute everything from price data
            python main.py --compute-returns-all           # Recompute just daily returns
            python main.py --compute-correlations-all      # Recompute correlations from price data
            python main.py --compute-volatility-all        # Recompute per-stock volatility from price data
                    """,
    )
    group = parser.add_mutually_exclusive_group(required=True)

    # ── Full daily pipeline ───────────────────────────────────
    group.add_argument(
        "--run-daily", action="store_true",
        help="Full daily pipeline: Polygon fetch + returns + VaR + vol + correlations for all tickers",
    )

    # ── Polygon fetch + compute (calls Polygon API) ──────────
    group.add_argument(
        "--fetch-and-compute-var", type=str, metavar="TICKER",
        help="Fetch prices from Polygon + compute returns + VaR + vol for ONE ticker",
    )
    group.add_argument(
        "--fetch-and-compute-var-all", action="store_true",
        help="Fetch prices from Polygon + compute returns + VaR + vol for ALL tickers in stock_price",
    )

    # ── Compute only (NO Polygon calls) ──────────────────────
    group.add_argument(
        "--compute-var", type=str, metavar="TICKER",
        help="Compute returns + VaR + vol for ONE ticker from existing Supabase data (no Polygon)",
    )
    group.add_argument(
        "--compute-var-all", action="store_true",
        help="Compute returns + VaR + vol for ALL tickers in stock_price (no Polygon)",
    )
    group.add_argument(
        "--compute-returns-all", action="store_true",
        help="Compute daily returns for ALL tickers from existing data (no Polygon)",
    )
    group.add_argument(
        "--compute-correlations-all", action="store_true",
        help="Compute pairwise correlations for ALL tickers from existing data (no Polygon)",
    )
    group.add_argument(
        "--compute-volatility-all", action="store_true",
        help="Compute per-stock volatility for ALL tickers from existing data (no Polygon)",
    )

    # ── Indices (yfinance scrape → index_price / index_return) ─
    group.add_argument(
        "--fetch-and-compute-index-all", action="store_true",
        help="Fetch prices + compute returns for ALL active indices in index_list",
    )
    group.add_argument(
        "--compute-index-returns-all", action="store_true",
        help="Compute returns for ALL active indices from existing index_price data",
    )

    # ── Utilities ─────────────────────────────────────────────
    group.add_argument(
        "--refresh-sp500", action="store_true",
        help="Refresh S&P 500 constituent list only",
    )
    group.add_argument(
        "--describe", action="store_true",
        help="Print current config and exit",
    )

    args = parser.parse_args()

    settings = Settings()

    if args.describe:
        print(settings.describe())
        return

    supabase = SupabaseClient(settings)
    price_client = PriceDataClient(settings)
    sp500 = SP500Tracker(supabase)
    var_engine = VaREngine()
    correlation_engine = CorrelationEngine()
    volatility_engine = VolatilityEngine()
    return_engine = ReturnEngine()

    pipeline = DailyPipeline(
        settings=settings, supabase=supabase, price_client=price_client,
        sp500_tracker=sp500, var_engine=var_engine,
        correlation_engine=correlation_engine,
        volatility_engine=volatility_engine,
        return_engine=return_engine,
    )

    backfill = BackfillJob(
        supabase=supabase, price_client=price_client,
        var_engine=var_engine, settings=settings,
        correlation_engine=correlation_engine,
        volatility_engine=volatility_engine,
        return_engine=return_engine,
    )

    # ── Route to the correct action ──────────────────────────
    if args.run_daily:
        await pipeline.run()

    elif args.compute_returns_all:
        await backfill.compute_returns_all()
        
    elif args.fetch_and_compute_var:
        await backfill.fetch_and_compute_var(args.fetch_and_compute_var)

    elif args.fetch_and_compute_var_all:
        await backfill.fetch_and_compute_var_all()

    elif args.compute_var:
        await backfill.compute_var(args.compute_var)

    elif args.compute_var_all:
        await backfill.compute_var_all()

    elif args.compute_correlations_all:
        await backfill.compute_correlations_all()

    elif args.compute_volatility_all:
        await backfill.compute_volatility_all()

    elif args.fetch_and_compute_index_all:
        await backfill.fetch_and_compute_index_all()

    elif args.compute_index_returns_all:
        await backfill.compute_index_returns_all()

    elif args.refresh_sp500:
        await sp500.refresh()

    logger.info("Done.")


if __name__ == "__main__":
    asyncio.run(main())