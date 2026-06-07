"""
Supabase client — thin wrapper around supabase-py.
========================================================

KEY METHOD FOR TICKER RESOLUTION:
  get_all_price_history_tickers() → returns all distinct tickers in stock_price.
  This is the primary way the daily pipeline and CLI commands determine
  which stocks to process. If a ticker has rows in stock_price, it's included.

Table name mapping (as of migration 009):
  price_history                → stock_price
  var_calculations_precomputed → stock_var
  global_correlations          → stock_correlation
  stock_volatility             → stock_volatility  (unchanged)
  stock_return                 → stock_return      (new this round)
"""

import logging
from datetime import date, datetime
from typing import Any

from supabase import create_client, Client

from config.settings import Settings

logger = logging.getLogger(__name__)


class SupabaseClient:
    def __init__(self, settings: Settings):
        self._client: Client = create_client(
            settings.supabase_url,
            settings.supabase_service_key,
        )

    # ── S&P 500 Constituents ──────────────────────────────────

    def get_sp500_tickers(self) -> list[dict]:
        resp = self._client.table("stock_sp500_constituents").select("*").execute()
        return resp.data

    def upsert_sp500_constituents(self, rows: list[dict]) -> None:
        if not rows:
            return
        self._client.table("stock_sp500_constituents").upsert(
            rows, on_conflict="ticker"
        ).execute()
        logger.info(f"Upserted {len(rows)} S&P 500 constituents")

    def mark_removed_constituents(self, removed_tickers: list[str]) -> None:
        if not removed_tickers:
            return
        self._client.table("stock_sp500_constituents").update(
            {"is_active": False, "removed_at": datetime.utcnow().isoformat()}
        ).in_("ticker", removed_tickers).execute()
        logger.info(f"Marked {len(removed_tickers)} tickers as removed")

    # ── Stock Price ───────────────────────────────────────────

    def get_all_price_history_tickers(self) -> list[str]:
        """
        Return all distinct tickers that have data in stock_price.

        THIS IS THE PRIMARY TICKER RESOLUTION METHOD.
        The daily pipeline and CLI "--all" commands use this to determine
        which stocks to process. If a ticker has rows here, it gets included.

        Uses pagination to handle tables with more than 1000 rows,
        since Supabase caps responses at 1000 per request.
        """
        all_tickers: set[str] = set()
        page_size = 1000
        offset = 0

        while True:
            resp = (
                self._client.table("stock_price")
                .select("ticker")
                .range(offset, offset + page_size - 1)
                .execute()
            )
            if not resp.data:
                break
            for row in resp.data:
                all_tickers.add(row["ticker"])
            if len(resp.data) < page_size:
                break
            offset += page_size

        result = sorted(all_tickers)
        logger.info(f"Found {len(result)} distinct tickers in stock_price: {result}")
        return result

    def get_latest_price_date(self, ticker: str) -> date | None:
        resp = (
            self._client.table("stock_price")
            .select("business_date")
            .eq("ticker", ticker)
            .order("business_date", desc=True)
            .limit(1)
            .execute()
        )
        if resp.data:
            return date.fromisoformat(resp.data[0]["business_date"])
        return None

    def upsert_price_history(self, rows: list[dict]) -> None:
        if not rows:
            return
        for i in range(0, len(rows), 1000):
            chunk = rows[i : i + 1000]
            self._client.table("stock_price").upsert(
                chunk, on_conflict="ticker,business_date"
            ).execute()
        logger.info(f"Upserted {len(rows)} stock_price rows")

    # ── Business Dates ────────────────────────────────────────

    def upsert_business_dates(
        self,
        business_dates: list[str] | list,
        calendar_code: str = "US",
    ) -> None:
        """
        Insert any new distinct business dates into the business_dates table.

        Called by the daily pipeline after price upsert: every date we just
        wrote price data for is, by definition, a business date for that
        calendar. ON CONFLICT DO NOTHING makes re-runs idempotent.

        Accepts either iso-format strings ("2026-04-17") or date objects.
        """
        if not business_dates:
            return

        normalized = set()
        for d in business_dates:
            if isinstance(d, (date, datetime)):
                normalized.add(d.isoformat()[:10])
            else:
                normalized.add(str(d))

        rows = [
            {"calendar_code": calendar_code, "business_date": d}
            for d in sorted(normalized)
        ]

        for i in range(0, len(rows), 1000):
            chunk = rows[i : i + 1000]
            self._client.table("business_dates").upsert(
                chunk, on_conflict="calendar_code,business_date"
            ).execute()
        logger.info(
            f"Upserted {len(rows)} business_dates rows "
            f"(calendar_code={calendar_code})"
        )

    def get_price_history(self, ticker: str, lookback_days: int) -> list[dict]:
        resp = (
            self._client.table("stock_price")
            .select("business_date, close, adj_close")
            .eq("ticker", ticker)
            .order("business_date", desc=True)
            .limit(lookback_days)
            .execute()
        )
        return list(reversed(resp.data)) if resp.data else []

    def get_full_price_history(self, ticker: str) -> list[dict]:
        """Fetch ALL price history for a ticker, sorted ascending by date.
        Paginates through results since Supabase caps at 1000 per request."""
        all_rows = []
        page_size = 1000
        offset = 0

        while True:
            resp = (
                self._client.table("stock_price")
                .select("business_date, close, adj_close")
                .eq("ticker", ticker)
                .order("business_date", desc=False)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            if not resp.data:
                break
            all_rows.extend(resp.data)
            if len(resp.data) < page_size:
                break
            offset += page_size

        logger.info(f"  {ticker}: fetched {len(all_rows)} total price rows from Supabase")
        return all_rows

    # ── Stock Returns ─────────────────────────────────────────

    def upsert_stock_returns(self, rows: list[dict]) -> None:
        """Upsert daily-return rows to stock_return table."""
        if not rows:
            return
        for i in range(0, len(rows), 1000):
            chunk = rows[i : i + 1000]
            self._client.table("stock_return").upsert(
                chunk,
                on_conflict="ticker,business_date",
            ).execute()
        logger.info(f"Upserted {len(rows)} stock_return rows")

    # ── Stock Volatility ──────────────────────────────────────

    def upsert_stock_volatility(self, rows: list[dict]) -> None:
        """Upsert per-stock volatility rows to stock_volatility table."""
        if not rows:
            return
        for i in range(0, len(rows), 1000):
            chunk = rows[i : i + 1000]
            self._client.table("stock_volatility").upsert(
                chunk,
                on_conflict="ticker,business_date,lookback_days",
            ).execute()
        logger.info(f"Upserted {len(rows)} stock_volatility rows")

    def delete_old_volatility(self, before_date: str) -> None:
        """Delete volatility rows older than a given date."""
        self._client.table("stock_volatility").delete().lt(
            "business_date", before_date
        ).execute()

    # ── Stock VaR ─────────────────────────────────────────────

    def upsert_var_calculations(self, rows: list[dict]) -> None:
        if not rows:
            return
        for i in range(0, len(rows), 1000):
            chunk = rows[i : i + 1000]
            self._client.table("stock_var").upsert(
                chunk,
                on_conflict="ticker,business_date,confidence_level,lookback_days",
            ).execute()
        logger.info(f"Upserted {len(rows)} stock_var rows")

    def delete_old_var(self, before_date: str) -> None:
        self._client.table("stock_var").delete().lt(
            "business_date", before_date
        ).execute()

    # ── Stock Correlations ────────────────────────────────────

    def upsert_global_correlations(self, rows: list[dict]) -> None:
        """Upsert pairwise correlation rows to stock_correlation."""
        if not rows:
            return
        for i in range(0, len(rows), 1000):
            chunk = rows[i : i + 1000]
            self._client.table("stock_correlation").upsert(
                chunk,
                on_conflict="ticker_a,ticker_b,period_days,business_date",
            ).execute()
        logger.info(f"Upserted {len(rows)} stock_correlation rows")

    def delete_old_correlations(self, before_date: str) -> None:
        """Delete correlation rows older than a given date."""
        self._client.table("stock_correlation").delete().lt(
            "business_date", before_date
        ).execute()

    # ── Index List / Price / Return ───────────────────────────

    def get_index_list(self) -> list[dict]:
        resp = self._client.table("index_list").select("*").execute()
        return resp.data

    def upsert_index_list(self, rows: list[dict]) -> None:
        if not rows:
            return
        self._client.table("index_list").upsert(rows, on_conflict="symbol").execute()
        logger.info(f"Upserted {len(rows)} index_list rows")

    def mark_removed_index_symbols(self, symbols: list[str], removed_at: str) -> None:
        if not symbols:
            return
        self._client.table("index_list").update(
            {"is_active": False, "removed_at": removed_at}
        ).in_("symbol", symbols).execute()
        logger.info(f"Marked {len(symbols)} index symbols as removed")

    def get_active_index_symbols(self) -> list[str]:
        resp = (
            self._client.table("index_list")
            .select("symbol")
            .eq("is_active", True)
            .execute()
        )
        return sorted(r["symbol"] for r in resp.data) if resp.data else []

    def get_latest_index_price_date(self, ticker: str) -> date | None:
        resp = (
            self._client.table("index_price")
            .select("business_date")
            .eq("ticker", ticker)
            .order("business_date", desc=True)
            .limit(1)
            .execute()
        )
        if resp.data:
            return date.fromisoformat(resp.data[0]["business_date"])
        return None

    def upsert_index_price(self, rows: list[dict]) -> None:
        if not rows:
            return
        for i in range(0, len(rows), 1000):
            chunk = rows[i : i + 1000]
            self._client.table("index_price").upsert(
                chunk, on_conflict="ticker,business_date"
            ).execute()
        logger.info(f"Upserted {len(rows)} index_price rows")

    def get_full_index_price_history(self, ticker: str) -> list[dict]:
        """Fetch ALL index price history for a ticker, sorted ascending by date."""
        all_rows = []
        page_size = 1000
        offset = 0
        while True:
            resp = (
                self._client.table("index_price")
                .select("business_date, close, adj_close")
                .eq("ticker", ticker)
                .order("business_date", desc=False)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            if not resp.data:
                break
            all_rows.extend(resp.data)
            if len(resp.data) < page_size:
                break
            offset += page_size
        logger.info(f"  {ticker}: fetched {len(all_rows)} total index_price rows from Supabase")
        return all_rows

    def upsert_index_returns(self, rows: list[dict]) -> None:
        if not rows:
            return
        for i in range(0, len(rows), 1000):
            chunk = rows[i : i + 1000]
            self._client.table("index_return").upsert(
                chunk, on_conflict="ticker,business_date"
            ).execute()
        logger.info(f"Upserted {len(rows)} index_return rows")

    # ── Generic ───────────────────────────────────────────────

    def rpc(self, function_name: str, params: dict | None = None) -> Any:
        return self._client.rpc(function_name, params or {}).execute()