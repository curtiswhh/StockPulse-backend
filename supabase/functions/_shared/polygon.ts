// _shared/polygon.ts
// Thin Polygon client used by the /quotes and /aggregates Edge Functions.
//
// Mirrors the surface of the iOS PolygonService that's being deleted, so
// behavior parity is easy to audit. Two calls only:
//
//   - fetchSnapshotBatch(tickers)  — live snapshot for many tickers in one HTTP call
//   - fetchAggregates(ticker, ...) — historical daily bars
//
// Auth: API key from POLYGON_API_KEY env var. Never logged.
//
// Ticker symbol normalization:
//   iOS (and most public sources) uses dash notation for class shares:
//     BRK-B, BF-B, BRK-A
//   Polygon uses dot notation for the same instruments:
//     BRK.B, BF.B, BRK.A
//   We translate at THIS boundary — callers in /quotes and /aggregates
//   keep passing iOS-canonical (dash) tickers, and responses come back
//   keyed by the same dash form. Polygon-specific naming never leaks out.

const POLYGON_BASE = "https://api.polygon.io";

function apiKey(): string {
  const key = Deno.env.get("POLYGON_API_KEY");
  if (!key) throw new Error("POLYGON_API_KEY env var not set");
  return key;
}

// MARK: - Ticker normalization

/// Matches a class-share style ticker: 1–5 letters, dash, single letter.
/// Examples that match:    BRK-B, BF-B, BRK-A, LEN-B
/// Examples that DO NOT:   SPY (no dash), BRK--B (double dash), BRK-BB (suffix too long)
/// Conservative on purpose — anything else with a dash is left untouched,
/// since dashes appear in non-equity symbols (preferred shares, units,
/// warrants) where Polygon's encoding varies and we shouldn't guess.
const CLASS_SHARE_DASH = /^[A-Z]{1,5}-[A-Z]$/;

/// Convert an iOS-canonical ticker into the form Polygon expects.
/// Idempotent: passes through anything that isn't a class-share pattern.
export function toPolygonTicker(ticker: string): string {
  return CLASS_SHARE_DASH.test(ticker) ? ticker.replace("-", ".") : ticker;
}

/// Inverse of `toPolygonTicker`. Used when keying Polygon's response back
/// to the iOS-canonical form, so cache writes and lookups match.
/// Same conservative pattern: only translate `^[A-Z]{1,5}\.[A-Z]$`.
const CLASS_SHARE_DOT = /^[A-Z]{1,5}\.[A-Z]$/;
export function fromPolygonTicker(ticker: string): string {
  return CLASS_SHARE_DOT.test(ticker) ? ticker.replace(".", "-") : ticker;
}

// MARK: - Snapshot DTOs (same shape as iOS PolygonService.SnapshotDTO)

export interface SnapshotDay {
  o?: number; h?: number; l?: number; c?: number; v?: number;
}
export interface SnapshotPrevDay {
  o?: number; h?: number; l?: number; c?: number; v?: number;
}
export interface SnapshotLastTrade {
  p?: number; t?: number;   // p = price, t = nanoseconds since epoch
}

export interface SnapshotDTO {
  ticker: string;
  day?: SnapshotDay;
  prevDay?: SnapshotPrevDay;
  lastTrade?: SnapshotLastTrade;
  updated?: number;         // nanoseconds since epoch
  /// Polygon-computed daily change (absolute) and change %. Both are
  /// derived server-side from (day.c or lastTrade.p) vs prevDay.c, so they
  /// are guaranteed self-consistent with `snapshotBestPrice` and
  /// `prevDay.c` on the same snapshot. Present on every successful
  /// snapshot in normal hours; absent/zero in the 03:30–09:30 ET window
  /// when Polygon has cleared the snapshot for the new session but no
  /// trades have happened yet. Callers MUST treat missing/zero as a
  /// signal to fall back to their own compute path.
  todaysChange?: number;
  todaysChangePerc?: number;
}

interface BatchSnapshotResponse {
  tickers?: SnapshotDTO[];
  status?: string;
}

/// Polygon-computed daily change (absolute, percent). Returns null unless
/// BOTH fields are present, finite, and `todaysChange` is non-zero — a
/// zero `todaysChange` paired with a present `todaysChangePerc` means
/// Polygon hasn't computed the day yet (pre-open snapshot reset window).
/// Returning null signals callers to use their own fallback compute.
export function snapshotTodaysChange(
  snap: SnapshotDTO,
): { change: number; changePct: number } | null {
  const c = snap.todaysChange;
  const p = snap.todaysChangePerc;
  if (typeof c !== "number" || !Number.isFinite(c)) return null;
  if (typeof p !== "number" || !Number.isFinite(p)) return null;
  // Both 0 → pre-open reset, not a real "flat" day. Filter out so the
  // fallback (aggregate_cache T vs T-1) runs and shows yesterday's close.
  if (c === 0 && p === 0) return null;
  return { change: c, changePct: p };
}

/// Best-effort current price from a snapshot. Mirrors iOS's
/// SnapshotDTO.bestPrice exactly so fused outputs match between client
/// and server during the transition.
export function snapshotBestPrice(snap: SnapshotDTO): number | null {
  if (snap.lastTrade?.p && snap.lastTrade.p > 0) return snap.lastTrade.p;
  if (snap.day?.c && snap.day.c > 0) return snap.day.c;
  return null;
}

/// Best timestamp for a snapshot's lastPrice, as ISO8601. Returns null
/// if neither lastTrade.t nor updated is populated.
export function snapshotBestTimestampISO(snap: SnapshotDTO): string | null {
  const ns = snap.lastTrade?.t ?? snap.updated;
  if (!ns || ns <= 0) return null;
  // Polygon timestamps are nanoseconds since epoch; JS Date wants ms.
  const ms = Math.floor(ns / 1_000_000);
  return new Date(ms).toISOString();
}

/// The trading-day business date that the snapshot's `lastPrice` belongs to,
/// in America/New_York time, formatted as YYYY-MM-DD. Used to align with
/// Supabase's `stock_price.business_date` for prev-close fusion.
///
/// Important on weekends/holidays: Polygon returns Friday's last trade as
/// the snapshot's `lastTrade.t`. The business date returned here is therefore
/// Friday — same as Supabase's most recent row. Callers compare these two
/// dates to decide whether `supabaseLatestClose` is "today" (skip it as
/// previousClose, use T-1 instead) or "yesterday" (use it as previousClose).
export function snapshotBusinessDateNY(snap: SnapshotDTO): string | null {
  const ns = snap.lastTrade?.t ?? snap.updated;
  if (!ns || ns <= 0) return null;
  const ms = Math.floor(ns / 1_000_000);
  const d = new Date(ms);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA gives ISO date format YYYY-MM-DD directly.
  return fmt.format(d);
}

// MARK: - Snapshot: Batch

/// Fetch live snapshots for many tickers. Polygon caps at ~250 per call;
/// chunks transparently. Returns a map keyed by the iOS-canonical ticker
/// (dash form for class shares — translation is transparent to callers).
///
/// Throws on HTTP non-2xx for any chunk. Callers should be prepared to
/// catch and fall back to per-ticker stock_price reads.
export async function fetchSnapshotBatch(
  tickers: string[],
): Promise<Record<string, SnapshotDTO>> {
  if (tickers.length === 0) return {};

  // Build a dash→dot map so we can re-key the response cleanly.
  // Most tickers pass through unchanged; class shares get translated.
  const toPolygon: Record<string, string> = {};
  const fromPolygon: Record<string, string> = {};
  for (const t of tickers) {
    const p = toPolygonTicker(t);
    toPolygon[t] = p;
    fromPolygon[p] = t;
  }
  const polygonTickers = tickers.map((t) => toPolygon[t]);

  const chunkSize = 250;
  const result: Record<string, SnapshotDTO> = {};

  for (let i = 0; i < polygonTickers.length; i += chunkSize) {
    const chunk = polygonTickers.slice(i, i + chunkSize);
    const url =
      `${POLYGON_BASE}/v2/snapshot/locale/us/markets/stocks/tickers` +
      `?tickers=${chunk.join(",")}&apiKey=${apiKey()}`;

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Polygon snapshot HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const decoded: BatchSnapshotResponse = await res.json();
    for (const snap of decoded.tickers ?? []) {
      // Translate the response ticker back to iOS canonical form. If the
      // map doesn't know about it (shouldn't happen, but defensive), use
      // the inverse regex.
      const canonical = fromPolygon[snap.ticker] ?? fromPolygonTicker(snap.ticker);
      // Overwrite the embedded ticker too — downstream code reads it as the
      // canonical name (e.g. when keying quote_cache).
      result[canonical] = { ...snap, ticker: canonical };
    }
  }

  return result;
}

// MARK: - Aggregates

export interface AggregateBarDTO {
  c: number;   // close
  h: number;   // high
  l: number;   // low
  o: number;   // open
  v: number;   // volume
  t: number;   // milliseconds since epoch (NOT nanoseconds — Polygon aggs differ from snapshots)
}

interface AggregatesResponse {
  results?: AggregateBarDTO[];
  resultsCount?: number;
  status?: string;
}

/// Fetch daily aggregate bars for a ticker over a date range.
/// `from` and `to` are ISO date strings (YYYY-MM-DD).
/// Accepts iOS-canonical tickers (e.g. BRK-B); translates to Polygon form
/// (BRK.B) internally. Response carries bars only, no ticker echo, so no
/// reverse translation is needed.
export async function fetchAggregates(
  ticker: string,
  from: string,
  to: string,
  adjusted = true,
): Promise<AggregateBarDTO[]> {
  const polygonTicker = toPolygonTicker(ticker);
  const url =
    `${POLYGON_BASE}/v2/aggs/ticker/${polygonTicker}/range/1/day/${from}/${to}` +
    `?adjusted=${adjusted}&sort=asc&limit=50000&apiKey=${apiKey()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Polygon aggs HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const decoded: AggregatesResponse = await res.json();
  return decoded.results ?? [];
}