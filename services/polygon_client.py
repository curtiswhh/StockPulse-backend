"""
Polygon.io API client — free-tier aware (5 requests/minute).

Uses a sliding-window rate limiter that tracks timestamps of recent calls.
When the limit is reached, it waits until the oldest call expires before
proceeding — no requests are dropped.
"""

import asyncio
import logging
import time
from collections import deque
from datetime import date

import httpx

from config.settings import Settings

logger = logging.getLogger(__name__)

POLYGON_BASE = "https://api.polygon.io"
FREE_TIER_MAX_CALLS = 5
FREE_TIER_WINDOW_SEC = 60


class PolygonClient:
    def __init__(self, settings: Settings):
        self._api_key = settings.polygon_api_key
        self._lock = asyncio.Lock()
        self._call_times: deque[float] = deque()

    async def _wait_for_rate_limit(self):
        """Block until a request slot is available within the sliding window."""
        while True:
            now = time.monotonic()
            # Evict timestamps older than the window
            while self._call_times and now - self._call_times[0] >= FREE_TIER_WINDOW_SEC:
                self._call_times.popleft()
            if len(self._call_times) < FREE_TIER_MAX_CALLS:
                self._call_times.append(now)
                return
            # Wait until the oldest call falls outside the window
            sleep_for = FREE_TIER_WINDOW_SEC - (now - self._call_times[0]) + 0.1
            logger.info(f"  Polygon rate limit reached — waiting {sleep_for:.1f}s")
            await asyncio.sleep(sleep_for)

    async def get_daily_bars(
        self, ticker: str, from_date: date, to_date: date,
    ) -> list[dict]:
        all_rows: list[dict] = []
        url = (
            f"{POLYGON_BASE}/v2/aggs/ticker/{ticker}/range/1/day/"
            f"{from_date.isoformat()}/{to_date.isoformat()}"
        )
        params = {
            "adjusted": "true", "sort": "asc",
            "limit": 50000, "apiKey": self._api_key,
        }

        # Lock guards only the rate-limit reservation; the HTTP request
        # itself runs unlocked so future parallel callers aren't serialized.
        async with self._lock:
            await self._wait_for_rate_limit()
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.get(url, params=params)
                resp.raise_for_status()
                data = resp.json()
                for bar in data.get("results", []):
                    bar_date = date.fromtimestamp(bar["t"] / 1000)
                    all_rows.append({
                        "ticker": ticker,
                        "business_date": bar_date.isoformat(),
                        "open": bar.get("o"),
                        "high": bar.get("h"),
                        "low": bar.get("l"),
                        "close": bar.get("c"),
                        "volume": int(bar["v"]) if bar.get("v") is not None else None,
                        "adj_close": bar.get("c"),
                    })
                logger.info(f"  {ticker}: fetched {len(all_rows)} bars from Polygon ({from_date} → {to_date})")
        except httpx.HTTPStatusError as e:
            logger.error(f"  {ticker}: Polygon HTTP {e.response.status_code}")
        except Exception as e:
            logger.error(f"  {ticker}: Polygon error — {e}")

        return all_rows