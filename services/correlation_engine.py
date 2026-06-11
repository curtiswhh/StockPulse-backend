"""
Correlation Engine — Rolling Pairwise Pearson Correlations.

For each pair of stocks (A, B) and each lookback period, computes
a rolling Pearson correlation of daily returns across every date
where both stocks have sufficient overlapping history.

Logic:
  - For day T, gather returns from [T - period + 1, T] inclusive
    (the most recent `period` trading days ending on T).
  - Compute Pearson r for each stock pair over that window.
  - This differs from VaR, which uses [T - period, T - 1] (i.e.,
    the window BEFORE day T). Correlation is descriptive of the
    relationship through day T, not a forward-looking estimate.
  - If fewer than (period * min_overlap_pct) common dates exist
    for a pair in the window, skip that pair for that date.

Output rows match the global_correlations table schema.

NOTE ON PAIR ORDERING:
  The global_correlations table enforces ticker_a < ticker_b using
  PostgreSQL's C collation (byte ordering). Python's str < operator
  compares Unicode codepoints, which is identical to C-collation byte
  ordering for ASCII strings — and all our tickers (including ^GSPC,
  since ^ is ASCII 0x5E) are ASCII. So a plain `<` is sufficient.
"""

import logging
from datetime import datetime, timezone

import numpy as np

logger = logging.getLogger(__name__)


def _pg_ordered_pair(a: str, b: str) -> tuple[str, str]:
    """
    Return (ticker_a, ticker_b) ordered to match the global_correlations
    CHECK constraint, which uses C collation (byte ordering).

    Python's str < comparison uses Unicode codepoints, which matches
    C collation for ASCII strings. This ensures the CHECK constraint
    (ticker_a COLLATE "C" < ticker_b COLLATE "C") is always satisfied.
    """
    if a < b:
        return (a, b)
    else:
        return (b, a)


class CorrelationEngine:
    def compute_rolling_correlations(
        self,
        all_prices: dict[str, list[dict]],
        period_days: int,
        min_overlap_pct: float = 0.8,
    ) -> list[dict]:
        """
        Compute rolling pairwise Pearson correlations for all ticker pairs
        over a single lookback period.

        Args:
            all_prices: dict mapping ticker to list of
                        {"business_date": ..., "close": ..., "adj_close": ...}
                        sorted ascending by date.
            period_days: lookback window (e.g. 90 or 252).
            min_overlap_pct: minimum fraction of overlapping dates required
                             for a pair (e.g. 0.8 = need 80% of period_days).

        Returns:
            list of dicts matching global_correlations schema.
        """
        tickers = sorted(all_prices.keys())
        if len(tickers) < 2:
            logger.warning(f"  Need at least 2 tickers, got {len(tickers)} — skipping")
            return []

        min_overlap = int(period_days * min_overlap_pct)

        # ── Build return series per ticker ─────────────────────────
        # returns_by_ticker[ticker] = {date_str: daily_return}
        returns_by_ticker: dict[str, dict[str, float]] = {}

        for ticker in tickers:
            prices = all_prices[ticker]
            if len(prices) < 2:
                continue

            returns = {}
            for i in range(1, len(prices)):
                prev_close = float(prices[i - 1]["adj_close"] or prices[i - 1]["close"])
                curr_close = float(prices[i]["adj_close"] or prices[i]["close"])
                if prev_close > 0:
                    returns[prices[i]["business_date"]] = (curr_close - prev_close) / prev_close

            if returns:
                returns_by_ticker[ticker] = returns

        valid_tickers = sorted(returns_by_ticker.keys())
        logger.info(
            f"  period={period_days}: {len(valid_tickers)} tickers with return data, "
            f"{len(valid_tickers) * (len(valid_tickers) - 1) // 2} pairs"
        )

        if len(valid_tickers) < 2:
            return []

        # ── Collect all unique dates across all tickers ────────────
        all_dates: set[str] = set()
        for returns in returns_by_ticker.values():
            all_dates.update(returns.keys())
        sorted_dates = sorted(all_dates)

        # ── Rolling correlation for each pair ──────────────────────
        results: list[dict] = []
        now_iso = datetime.now(timezone.utc).isoformat()
        pairs_computed = 0

        for i in range(len(valid_tickers)):
            for j in range(i + 1, len(valid_tickers)):
                # Order pair to match the database CHECK constraint
                ticker_a, ticker_b = _pg_ordered_pair(
                    valid_tickers[i], valid_tickers[j]
                )
                returns_a = returns_by_ticker[ticker_a]
                returns_b = returns_by_ticker[ticker_b]

                # Find dates where both tickers have returns
                common_dates = sorted(
                    set(returns_a.keys()) & set(returns_b.keys())
                )

                if len(common_dates) < min_overlap:
                    logger.info(
                        f"    {ticker_a}↔{ticker_b}: only {len(common_dates)} "
                        f"common dates (need {min_overlap}) — skipping"
                    )
                    continue

                # Roll through each date that has enough history
                pair_rows = 0
                for t_idx in range(len(common_dates)):
                    # Window: [t_idx - period + 1, t_idx] inclusive
                    window_start = max(0, t_idx - period_days + 1)
                    window_dates = common_dates[window_start : t_idx + 1]

                    if len(window_dates) < min_overlap:
                        continue

                    arr_a = np.array([returns_a[d] for d in window_dates])
                    arr_b = np.array([returns_b[d] for d in window_dates])

                    # Skip if either series has zero variance
                    if np.std(arr_a) == 0 or np.std(arr_b) == 0:
                        continue

                    corr = float(np.corrcoef(arr_a, arr_b)[0, 1])

                    if np.isnan(corr):
                        continue

                    results.append({
                        "ticker_a": ticker_a,
                        "ticker_b": ticker_b,
                        "business_date": common_dates[t_idx],
                        "correlation": round(corr, 6),
                        "period_days": period_days,
                        "calculated_at": now_iso,
                    })
                    pair_rows += 1

                if pair_rows > 0:
                    pairs_computed += 1
                    logger.info(
                        f"    {ticker_a}↔{ticker_b}: {pair_rows} daily correlation rows"
                    )

        logger.info(
            f"  period={period_days}: computed {len(results)} total rows "
            f"across {pairs_computed} pairs"
        )
        return results