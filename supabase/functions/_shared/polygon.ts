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

// MARK: - Index vs stock asset class
//
// Indices are stored app-wide under a VENDOR-NEUTRAL canonical symbol
// (e.g. "SPX") — never Polygon's "I:SPX". The `I:` prefix is Polygon-
// specific and lives only inside this file, exactly like the BRK-B↔BRK.B
// class-share translation below. Swapping vendors later means editing this
// one map, not every table that holds a ticker.

const INDEX_POLYGON_PREFIX = "I:";

/// Canonical index symbols this app supports. Keep in sync with the
/// `polygon_index_list` table (which is the source of truth for search).
/// Membership here is what routes a ticker to the v3 indices endpoints.
const INDEX_CANONICAL = new Set<string>([
  "SPX", "NDX", "DJI", "VIX", "RUT",
]);

/// True when `ticker` is a canonical index symbol (not a stock).
export function isIndex(ticker: string): boolean {
  return INDEX_CANONICAL.has(ticker.toUpperCase());
}

/// Convert an iOS-canonical ticker into the form Polygon expects.
/// Idempotent: passes through anything that isn't a class-share or index.
export function toPolygonTicker(ticker: string): string {
  if (INDEX_CANONICAL.has(ticker.toUpperCase())) return INDEX_POLYGON_PREFIX + ticker.toUpperCase();
  return CLASS_SHARE_DASH.test(ticker) ? ticker.replace("-", ".") : ticker;
}

/// Inverse of `toPolygonTicker`. Used when keying Polygon's response back
/// to the iOS-canonical form, so cache writes and lookups match.
/// Same conservative pattern: only translate `^[A-Z]{1,5}\.[A-Z]$`.
const CLASS_SHARE_DOT = /^[A-Z]{1,5}\.[A-Z]$/;
export function fromPolygonTicker(ticker: string): string {
  if (ticker.startsWith(INDEX_POLYGON_PREFIX)) return ticker.slice(INDEX_POLYGON_PREFIX.length);
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

// v3 indices snapshot wire shape (normalized into SnapshotDTO before use).
// Only the fields we actually consume are declared.
interface IndexSnapshotSession {
  change?: number;
  change_percent?: number;
  previous_close?: number;
}
interface IndexSnapshotResult {
  ticker: string;
  value?: number;
  session?: IndexSnapshotSession;
  last_updated?: number;   // nanoseconds since epoch
}
interface IndexSnapshotResponse {
  results?: IndexSnapshotResult[];
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
export type PriceSource = "trade" | "dayClose";
export interface BestPrice { price: number; source: PriceSource; }

/// Same lastTrade→day.c preference as before, but labels the source so
/// callers can tell a live trade from a (possibly lagging) session close.
export function snapshotBestPrice(snap: SnapshotDTO): BestPrice | null {
  if (snap.lastTrade?.p && snap.lastTrade.p > 0) return { price: snap.lastTrade.p, source: "trade" };
  if (snap.day?.c && snap.day.c > 0) return { price: snap.day.c, source: "dayClose" };
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

/// Fetch live snapshots for many tickers. Routes stocks to the v2 stocks
/// snapshot and indices to the v3 indices snapshot, normalizing both into
/// one `SnapshotDTO` shape. Returns a map keyed by the iOS-canonical ticker
/// (dash form for class shares, bare symbol for indices — translation is
/// transparent to callers).
///
/// Throws on HTTP non-2xx for any chunk. Callers should be prepared to
/// catch and fall back to per-ticker stock_price reads.
export async function fetchSnapshotBatch(
  tickers: string[],
): Promise<Record<string, SnapshotDTO>> {
  if (tickers.length === 0) return {};

  const stocks = tickers.filter((t) => !isIndex(t));
  const indices = tickers.filter((t) => isIndex(t));

  // Independent settle: an index-snapshot failure (e.g. plan tier) must not
  // wipe out stock quotes, and vice versa.
  const [stockRes, indexRes] = await Promise.allSettled([
    fetchStockSnapshots(stocks),
    fetchIndexSnapshots(indices),
  ]);
  if (stockRes.status === "rejected") console.error("[polygon] stock snapshot failed:", stockRes.reason);
  if (indexRes.status === "rejected") console.error("[polygon] index snapshot failed:", indexRes.reason);

  return {
    ...(stockRes.status === "fulfilled" ? stockRes.value : {}),
    ...(indexRes.status === "fulfilled" ? indexRes.value : {}),
  };
}

/// v2 stocks snapshot — unchanged behavior, extracted from the old batch fn.
async function fetchStockSnapshots(tickers: string[]): Promise<Record<string, SnapshotDTO>> {
  if (tickers.length === 0) return {};

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
      const canonical = fromPolygon[snap.ticker] ?? fromPolygonTicker(snap.ticker);
      result[canonical] = { ...snap, ticker: canonical };
    }
  }

  return result;
}

/// v3 indices snapshot, normalized into the stock-shaped `SnapshotDTO` so
/// downstream fusion/evaluators never branch on asset class. Indices have
/// no trades and no volume: `value` becomes both day.c and lastTrade.p,
/// `session.previous_close` becomes prevDay.c, and session change fields map
/// straight onto todaysChange/todaysChangePerc.
async function fetchIndexSnapshots(tickers: string[]): Promise<Record<string, SnapshotDTO>> {
  if (tickers.length === 0) return {};

  // Index snapshots need a paid index tier (Starter+). On the free tier the
  // call 403s, so skip it and let fusion fall back to aggregate_cache. Set
  // POLYGON_INDEX_SNAPSHOTS=true once the plan includes snapshots.
  if (Deno.env.get("POLYGON_INDEX_SNAPSHOTS") !== "true") return {};

  const polygonTickers = tickers.map(toPolygonTicker);
  const chunkSize = 250;
  const result: Record<string, SnapshotDTO> = {};

  for (let i = 0; i < polygonTickers.length; i += chunkSize) {
    const chunk = polygonTickers.slice(i, i + chunkSize);
    const url =
      `${POLYGON_BASE}/v3/snapshot/indices` +
      `?ticker.any_of=${chunk.join(",")}&apiKey=${apiKey()}`;

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Polygon index snapshot HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const decoded: IndexSnapshotResponse = await res.json();
    for (const idx of decoded.results ?? []) {
      const canonical = fromPolygonTicker(idx.ticker);
      const normalized = normalizeIndexSnapshot(canonical, idx);
      if (normalized) result[canonical] = normalized;
    }
  }

  return result;
}

/// Map a v3 index result onto a SnapshotDTO. Returns null if there's no
/// usable value (e.g. an error entry), so callers skip it cleanly.
function normalizeIndexSnapshot(canonical: string, idx: IndexSnapshotResult): SnapshotDTO | null {
  const value = idx.value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const s = idx.session;
  return {
    ticker: canonical,
    day: { c: value },
    prevDay: { c: s?.previous_close },
    lastTrade: { p: value, t: idx.last_updated },
    updated: idx.last_updated,
    todaysChange: s?.change,
    todaysChangePerc: s?.change_percent,
  };
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
  // Indices have no splits; requesting adjusted data isn't entitled on the
  // index tier, so always request unadjusted for them.
  const adj = isIndex(ticker) ? false : adjusted;
  const url =
    `${POLYGON_BASE}/v2/aggs/ticker/${polygonTicker}/range/1/day/${from}/${to}` +
    `?adjusted=${adj}&sort=asc&limit=50000&apiKey=${apiKey()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    // An index 403 means the plan tier doesn't cover this ticker — a known,
    // expected condition, not a failure. Treat as no data so callers skip it
    // quietly rather than logging a scary error every refresh.
    if (res.status === 403 && isIndex(ticker)) {
      console.warn(`[polygon] index ${ticker} not entitled on current plan — skipping`);
      return [];
    }
    throw new Error(`Polygon aggs HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const decoded: AggregatesResponse = await res.json();
  return decoded.results ?? [];
}