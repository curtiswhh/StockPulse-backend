"""
Index Tracker — syncs the gold-source repo file into the yf_index_list table.

config/index_list.py is the source of truth. Each run: upsert its rows,
soft-delete (is_active=false) symbols no longer present, reactivate symbols
that return. Mirrors SP500Tracker, but the source is a local constant rather
than a remote CSV.
"""

import logging
from datetime import datetime

from config.index_list import INDEX_LIST
from services.supabase_client import SupabaseClient

logger = logging.getLogger(__name__)


class IndexTracker:
    def __init__(self, supabase: SupabaseClient):
        self._supabase = supabase

    def sync(self) -> dict:
        """Sync config/index_list.py into yf_index_list (upsert + soft-delete)."""
        file_symbols = {row["symbol"] for row in INDEX_LIST}
        db_rows = self._supabase.get_index_list()

        db_active = {r["symbol"] for r in db_rows if r.get("is_active", True)}
        removed = db_active - file_symbols

        now = datetime.utcnow().isoformat()
        rows_to_upsert = [
            {"symbol": r["symbol"], "name": r["name"], "region": r.get("region"),
             "is_active": True, "removed_at": None}
            for r in INDEX_LIST
        ]
        self._supabase.upsert_index_list(rows_to_upsert)

        if removed:
            self._supabase.mark_removed_index_symbols(list(removed), removed_at=now)
            logger.info(f"  Soft-deleted from yf_index_list: {sorted(removed)}")

        logger.info(f"  yf_index_list synced: {len(file_symbols)} active symbols")
        return {"active": sorted(file_symbols), "removed": sorted(removed)}

    def get_active_symbols(self) -> list[str]:
        return self._supabase.get_active_index_symbols()