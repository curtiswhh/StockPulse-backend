"""
S&P 500 Tracker — gold-source edition.

Changes from previous version:
  - Switched from Wikipedia scraping to GitHub CSV dataset (no 403 issues)
  - Adds retry with backoff for transient failures
  - Delta-only logic: only upserts new/changed rows, soft-deletes removed tickers
  - Reactivates tickers that return to the S&P 500 (clears removed_at)
"""

import csv
import io
import logging
from datetime import datetime, timezone

import httpx

from services.supabase_client import SupabaseClient

logger = logging.getLogger(__name__)

# Maintained GitHub dataset — no bot detection issues
SP500_CSV_URL = (
    "https://raw.githubusercontent.com/datasets/"
    "s-and-p-500-companies/main/data/constituents.csv"
)

_MAX_RETRIES = 3


class SP500Tracker:
    def __init__(self, supabase: SupabaseClient):
        self._supabase = supabase

    async def refresh(self) -> dict:
        """Fetch S&P 500 list, diff against Supabase, apply delta only."""
        current_web = await self._fetch_constituents()
        current_db_rows = self._supabase.get_sp500_tickers()

        db_active = {r["ticker"] for r in current_db_rows if r.get("is_active", True)}
        db_all = {r["ticker"] for r in current_db_rows}
        web_tickers = {r["ticker"] for r in current_web}

        added = web_tickers - db_active       # new or reactivated
        removed = db_active - web_tickers     # dropped from index
        truly_new = web_tickers - db_all      # never seen before

        # ── If table was empty, upsert everything ──
        if not db_all:
            self._supabase.upsert_sp500_constituents(current_web)
            logger.info(f"  Initial load: upserted all {len(current_web)} constituents")
        else:
            # ── Upsert only new/changed rows ──
            rows_to_upsert = [r for r in current_web if r["ticker"] in added or r["ticker"] in truly_new]
            if rows_to_upsert:
                self._supabase.upsert_sp500_constituents(rows_to_upsert)
                logger.info(f"  Upserted {len(rows_to_upsert)} new/reactivated constituents")

        # ── Soft-delete removed tickers ──
        if removed:
            self._supabase.mark_removed_constituents(list(removed))
            logger.info(f"  Removed from S&P 500: {sorted(removed)}")

        if added:
            logger.info(f"  Added to S&P 500: {sorted(added)}")

        logger.info(f"  S&P 500 constituent count: {len(web_tickers)}")
        return {"added": sorted(added), "removed": sorted(removed), "total": len(web_tickers)}

    def get_active_tickers(self) -> list[str]:
        rows = self._supabase.get_sp500_tickers()
        return [r["ticker"] for r in rows if r.get("is_active", True)]

    async def _fetch_constituents(self) -> list[dict]:
        """Fetch S&P 500 list from GitHub CSV with retry."""
        last_err = None
        for attempt in range(1, _MAX_RETRIES + 1):
            try:
                async with httpx.AsyncClient(
                    timeout=20, follow_redirects=True
                ) as client:
                    resp = await client.get(SP500_CSV_URL)
                    resp.raise_for_status()
                return self._parse_csv(resp.text)
            except (httpx.HTTPStatusError, httpx.RequestError) as e:
                last_err = e
                logger.warning(f"  GitHub CSV attempt {attempt}/{_MAX_RETRIES} failed: {e}")
                if attempt < _MAX_RETRIES:
                    import asyncio
                    await asyncio.sleep(2 ** attempt)

        raise RuntimeError(f"S&P 500 fetch failed after {_MAX_RETRIES} attempts: {last_err}")

    def _parse_csv(self, text: str) -> list[dict]:
        """Parse the GitHub CSV into constituent dicts.

        CSV columns: Symbol, Security, GICS Sector, GICS Sub-Industry,
                     Headquarters Location, Date added, CIK, Founded
        """
        reader = csv.DictReader(io.StringIO(text))
        constituents: list[dict] = []
        now = datetime.now(timezone.utc).isoformat()

        for row in reader:
            ticker = row.get("Symbol", "").strip().replace(".", "-")
            if not ticker:
                continue
            constituents.append({
                "ticker": ticker,
                "company_name": row.get("Security", "").strip(),
                "sector": row.get("GICS Sector", "").strip(),
                "sub_industry": row.get("GICS Sub-Industry", "").strip(),
                "date_added_to_sp500": row.get("Date added", "").strip() or None,
                "is_active": True,
                "removed_at": None,
                "updated_at": now,
            })
        return constituents