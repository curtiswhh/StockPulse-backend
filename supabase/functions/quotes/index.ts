// functions/quotes/index.ts
// POST /functions/v1/quotes
//
// Request:  { "tickers": ["AAPL", "MSFT", ...], "force": false }
// Response: { "AAPL": MarketQuoteDTO, "MSFT": MarketQuoteDTO, ... }
//
// Pipeline per request:
//   1. Read all requested tickers from `quote_cache`.
//   2. Bucket into HIT (fresh under TTL) and MISS (stale or absent).
//      `force: true` skips this and treats every ticker as MISS.
//   3. For MISS:
//        a. Batch-call Polygon snapshot (one HTTP call up to 250 tickers).
//        b. Identify the subset that will need `aggregate_cache` to fuse —
//           tickers where Polygon snapshot is missing OR in the reset
//           window (03:30–09:30 ET). Tickers with full live data skip this.
//        c. AWAIT a warmup of `aggregate_cache` for that subset only. This
//           guarantees a single PTR is sufficient: without it, the very
//           first PTR for a never-seen ticker hits an empty cache and the
//           row falls through to null. The warmup's pre-check skips any
//           ticker that already has a wide-enough fresh row (never narrows
//           a 5y row down to 10d).
//        d. Read `aggregate_cache` (now seeded) for the subset.
//        e. Fuse into MarketQuoteDTO. Happy-path tickers got their result
//           from Polygon alone; subset tickers fused with cache help.
//        f. UPSERT non-degenerate rows into `quote_cache`. Rows with no
//           usable change signal are filtered to avoid poisoning the cache.
//   4. Return HITs ∪ freshly-fused MISS payloads.
//
// TTL is set in _shared/market_state.ts and applied at read time. Rows in
// `quote_cache` are never deleted; they're overwritten on the next miss.
//
// Auth: anon key (apikey header) is sufficient. Anyone with the anon key
// can call. Same trust posture as direct REST calls. Add JWT verification
// here when monetization gates this endpoint.

import { errorResponse, jsonResponse, preflight } from "../_shared/cors.ts";
import {
  AggregateBarDTO,
  fetchAggregates,
  fetchSnapshotBatch,
  snapshotBestPrice,
  snapshotBestTimestampISO,
  snapshotBusinessDateNY,
  snapshotTodaysChange,
  SnapshotDTO,
} from "../_shared/polygon.ts";
import { marketState } from "../_shared/market_state.ts";
import { admin } from "../_shared/supabase_admin.ts";

// MARK: - DTOs

/// Wire shape returned to iOS. Field names match `MarketQuote` exactly so
/// the iOS decoder is a one-line `MarketQuote(from: dto)`. `fetchedAt` is
/// set on the iOS side at decode time, not here.
interface MarketQuoteDTO {
  ticker: string;
  lastPrice: number;
  previousClose: number;
  dailyChange: number;
  dailyChangePct: number;
  latestBusinessDate: string;     // ISO date the previousClose belongs to (T-1)
  previousBusinessDate: string;   // ISO date for the close before that (T-2)
  quoteTimestamp: string | null;  // ISO8601 of when lastPrice was sampled at source
  source: "live" | "supabaseClose";
}

interface RequestBody {
  tickers?: string[];
  /// When `true`, bypass the `quote_cache` HIT/MISS read entirely and treat
  /// every requested ticker as a MISS — Polygon is called, the result is
  /// upserted into `quote_cache`, and `fetched_at` is refreshed. The
  /// response shape is unchanged. iOS sets this on pull-to-refresh so users
  /// always see the work happen; the per-isolate Polygon batch + 1s open-
  /// market TTL still prevent abuse.
  force?: boolean;
}

interface StockPriceRow {
  ticker: string;
  business_date: string;
  close: number | null;
}

// MARK: - Entry point

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const tickers = (body.tickers ?? []).filter((t) => typeof t === "string" && t.length > 0);
  if (tickers.length === 0) return jsonResponse({}, 200);

  // Dedupe + uppercase canonicalize.
  const unique = Array.from(new Set(tickers.map((t) => t.toUpperCase())));
  const force = body.force === true;

  try {
    const result = await handleQuotes(unique, force);
    return jsonResponse(result);
  } catch (err) {
    console.error("[quotes] handler failed:", err);
    return errorResponse((err as Error).message ?? "Internal error", 500);
  }
});

// MARK: - Handler

/// Read every requested ticker's payload from `quote_cache`, ignoring TTL.
/// The presence of a row IS the answer — staleness checks are no longer the
/// gate, refresh work happens in the background instead. Returns a map keyed
/// by ticker. Tickers without a row (never been quoted) are simply absent.
async function readAllCached(tickers: string[]): Promise<Record<string, MarketQuoteDTO>> {
  const { data, error } = await admin()
    .from("polygon_quote_cache")
    .select("ticker, payload")
    .in("ticker", tickers);

  if (error) {
    console.error("[quotes] cache read failed:", error);
    return {};
  }
  const out: Record<string, MarketQuoteDTO> = {};
  for (const row of (data ?? []) as { ticker: string; payload: MarketQuoteDTO }[]) {
    out[row.ticker] = row.payload;
  }
  return out;
}

/// Background refresh: Polygon snapshot + warmup + fuse + upsert. Same
/// pipeline as before, just no longer gating the response. If this fails or
/// drops tickers, the next call still serves the existing `quote_cache`
/// rows — no UI impact. iOS sees fresher data on the call after this one
/// finishes writing.
async function refreshInBackground(tickers: string[]): Promise<void> {
  if (tickers.length === 0) return;

  const snapshots = await fetchSnapshotsSafe(tickers);
  console.log(`[quotes] bg polygon snapshots=${Object.keys(snapshots).length}/${tickers.length}`);

  const needCache = tickers.filter((t) => {
    const snap = snapshots[t];
    if (!snap) return true;
    if (snapshotTodaysChange(snap) === null) return true;
    if (!snap.prevDay?.c || snap.prevDay.c <= 0) return true;
    return false;
  });

  if (needCache.length > 0) {
    try {
      await warmAggregateCache(needCache);
    } catch (e) {
      console.error("[quotes] bg warmAggregateCache failed (continuing):", e);
    }
  }

  const prevCloses = needCache.length > 0 ? await fetchPrevCloses(needCache) : {};

  const fused: MarketQuoteDTO[] = [];
  let nulls = 0;
  for (const ticker of tickers) {
    const dto = fuseQuote(ticker, snapshots[ticker] ?? null, prevCloses[ticker] ?? []);
    if (dto) fused.push(dto);
    else nulls++;
  }
  console.log(`[quotes] bg fused=${fused.length} null=${nulls}`);

  if (fused.length > 0) {
    try {
      const n = await upsertCache(fused);
      console.log(`[quotes] bg upserted ${n} rows`);
    } catch (e) {
      console.error("[quotes] bg cache upsert failed:", e);
    }
  }
}

async function handleQuotes(tickers: string[], _force: boolean): Promise<Record<string, MarketQuoteDTO>> {
  const state = marketState();
  console.log(`[quotes] req tickers=${tickers.length} state=${state}`);

  // PATH 2 (cache → user). Unconditional. Read every requested ticker's
  // row from quote_cache. Presence is the answer; freshness never gates.
  const cached = await readAllCached(tickers);
  console.log(`[quotes] served from cache: ${Object.keys(cached).length}/${tickers.length}`);

  // PATH 1 (Polygon → cache). Gated by market state.
  //
  //   - open / extended: refresh every requested ticker in the background.
  //     This is the standard live-data flow.
  //
  //   - closed: do NOT touch Polygon for tickers that already have a
  //     quote_cache row — there's nothing new to fetch. Only refresh tickers
  //     that are missing from the cache entirely (e.g. user just added a
  //     stock after-hours and there's no row yet). For those tickers, we
  //     need Polygon and aggregate_cache populated so the row exists for
  //     the user to read on the next call.
  const tickersToRefresh =
    state === "closed"
      ? tickers.filter((t) => !(t in cached))
      : tickers;

  if (tickersToRefresh.length > 0) {
    refreshInBackground(tickersToRefresh).catch((e) => {
      console.error("[quotes] background refresh failed:", e);
    });
  }

  // Some cached rows can be "degenerate" — written when fuseQuote had no
  // useful change signal (lastPrice === previousClose, both changes zero,
  // empty business date). The `isDegeneratePayload` upsert filter is
  // supposed to keep these out, but legacy rows exist. When we see one,
  // re-derive the five computable fields from aggregate_cache's last two
  // bars. We do NOT write the derived row back — a future Polygon refresh
  // should be free to overwrite quote_cache without first having to
  // overcome a derived ghost row.
  const degenerateTickers = Object.keys(cached).filter((t) => isDegeneratePayload(cached[t]));
  if (degenerateTickers.length > 0) {
    const bars = await fetchPrevCloses(degenerateTickers);
    for (const ticker of degenerateTickers) {
      const derived = deriveFromAggregateCache(cached[ticker], bars[ticker] ?? []);
      if (derived) cached[ticker] = derived;
    }
    console.log(`[quotes] derived ${degenerateTickers.length} degenerate rows from aggregate_cache`);
  }

  return cached;
}

/// Predicate for "row carries no useful change signal":
/// `lastPrice === previousClose`, both changes zero, empty business date.
/// Used in two places:
///   1. `upsertCache` — filters these out before writing to quote_cache.
///   2. `handleQuotes` — detects legacy rows that slipped past (1) and
///      derives meaningful fields from aggregate_cache instead.
function isDegeneratePayload(p: MarketQuoteDTO): boolean {
  return p.dailyChange === 0 &&
         p.dailyChangePct === 0 &&
         p.lastPrice === p.previousClose &&
         p.latestBusinessDate === "";
}

/// Re-derive a degenerate quote's price/return fields from aggregate_cache.
/// Uses bar[0] (latest) as `lastPrice` and bar[1] (T-1) as `previousClose`.
/// Returns null when we don't have two usable bars — caller keeps the
/// degenerate row as-is rather than fabricate data.
///
/// `bars` arrives in the shape `fetchPrevCloses` returns: index 0 = latest,
/// index 1 = T-1, index 2 = T-2.
function deriveFromAggregateCache(
  base: MarketQuoteDTO,
  bars: StockPriceRow[],
): MarketQuoteDTO | null {
  const latest = bars[0]?.close;
  const prev = bars[1]?.close;
  if (!latest || latest <= 0 || !prev || prev <= 0) return null;

  return {
    ...base,
    lastPrice: latest,
    previousClose: prev,
    dailyChange: latest - prev,
    dailyChangePct: ((latest - prev) / prev) * 100,
    latestBusinessDate: bars[0]?.business_date ?? "",
    previousBusinessDate: bars[1]?.business_date ?? "",
    source: "supabaseClose",
  };
}

// MARK: - Polygon fetch (with safe fallback)

/// Returns `{}` on Polygon failure rather than throwing — that lets us
/// still serve supabaseClose-only quotes for missed tickers.
async function fetchSnapshotsSafe(
  tickers: string[],
): Promise<Record<string, SnapshotDTO>> {
  try {
    return await fetchSnapshotBatch(tickers);
  } catch (err) {
    console.error("[quotes] Polygon batch failed, falling back to supabaseClose only:", err);
    return {};
  }
}

// MARK: - Prev-close fetch from aggregate_cache

/// Returns the last 2-3 bars per ticker as the legacy
/// `{ticker, business_date, close}` shape `fuseQuote` consumes. Index 0 is
/// the latest bar in the cache, 1 is T-1, 2 is T-2. Empty array means no
/// cached row for that ticker (fusion falls through to Path 4).
///
/// Source: `aggregate_cache.bars` (JSONB array of AggregateBarDTO). After
/// migration 013, the table holds exactly one row per (ticker, adjusted) —
/// so this is a plain `IN` lookup with no ordering or dedupe needed.
///
/// Seeding dependency: a brand-new ticker the user just added has no
/// `aggregate_cache` row until its first sparkline load runs. Until then,
/// fusion falls through to Path 4. WatchlistViewModel.loadWatchlist runs
/// sparkline load on every cold start, so this gap closes within seconds
/// of opening the app.
async function fetchPrevCloses(tickers: string[]): Promise<Record<string, StockPriceRow[]>> {
  const { data, error } = await admin()
    .from("polygon_aggregate_cache")
    .select("ticker, bars")
    .in("ticker", tickers)
    .eq("adjusted", true);

  if (error) {
    console.error("[quotes] aggregate_cache read failed:", error);
    return {};
  }

  const grouped: Record<string, StockPriceRow[]> = {};
  for (const row of (data ?? []) as { ticker: string; bars: AggregateBarDTO[] }[]) {
    const bars = row.bars ?? [];
    if (bars.length === 0) continue;

    // bars in the JSONB are ascending by `t` (Polygon's natural order).
    // Take the last 3, convert to legacy shape, reverse so index 0 = latest.
    grouped[row.ticker] = bars
      .slice(-3)
      .reverse()
      .map((bar) => ({
        ticker: row.ticker,
        business_date: businessDateNY(bar.t),
        close: bar.c,
      }))
      // Defensive: skip bars whose timestamp produced an empty date string.
      .filter((r) => r.business_date !== "");
  }

  return grouped;
}

/// Convert an aggregate bar's epoch-ms timestamp to a `YYYY-MM-DD` string
/// in America/New_York. Mirrors `snapshotBusinessDateNY` from the shared
/// polygon module (snapshots use nanoseconds; aggregates use milliseconds).
function businessDateNY(ms: number): string {
  if (!ms || ms <= 0) return "";
  const d = new Date(ms);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

// MARK: - Fusion

/// Build a MarketQuoteDTO from a Polygon snapshot and (optionally) the
/// ticker's last few cached closes. Preference order:
///
///   HAPPY PATH — Polygon snapshot has live data with a non-zero daily move:
///     Use snapshot fields directly. lastPrice / previousClose / dailyChange /
///     dailyChangePct all come from the same Polygon response, guaranteed
///     self-consistent. `aggregate_cache` is NOT read. source: "live".
///
///   RESET-WINDOW FALLBACK — Polygon has cleared the snapshot for the next
///   session but no trades have happened yet (`todaysChange == 0` AND
///   `day.c == 0`, typically 03:30–09:30 ET). Without this fallback, every
///   ticker would display "0.00%" for ~6 hours each morning — unacceptable
///   for non-US users whose waking hours overlap this window.
///     Use `snap.prevDay.c` as lastPrice (yesterday's settled close).
///     Use `aggregate_cache` T-2 close to compute yesterday's move:
///       dailyChangePct = (prevDay.c / T-2.close - 1) * 100
///     If T-2 isn't cached, we still emit a row but with `dailyChange = 0`
///     so callers can render at least the price. source: "live".
///
///   POLYGON-DOWN FALLBACK — Snapshot returned nothing for this ticker.
///     Use whatever `aggregate_cache` has. T + T-1 → full row; T only →
///     price with zero change. source: "supabaseClose".
///
///   GIVE UP — nothing usable → null (filtered from the response).
function fuseQuote(
  ticker: string,
  snap: SnapshotDTO | null,
  prevRows: StockPriceRow[],
): MarketQuoteDTO | null {
  const live = snap ? snapshotBestPrice(snap) : null;
  const snapBD = snap ? snapshotBusinessDateNY(snap) : null;
  const prevDayClose = snap?.prevDay?.c ?? null;
  const polyChange = snap ? snapshotTodaysChange(snap) : null;

  // === HAPPY PATH ===
  // Polygon gave us a live price and a non-zero daily move.
  // Nothing else is needed.
  if (live && live > 0 && prevDayClose && prevDayClose > 0 && polyChange !== null) {
    return {
      ticker,
      lastPrice: live,
      previousClose: prevDayClose,
      dailyChange: polyChange.change,
      dailyChangePct: polyChange.changePct,
      latestBusinessDate: snapBD ?? "",
      previousBusinessDate: "",
      quoteTimestamp: snapshotBestTimestampISO(snap!),
      source: "live",
    };
  }

  // === RESET-WINDOW FALLBACK ===
  // Snapshot exists with prevDay.c, but no live trades yet (live missing OR
  // polyChange null because Polygon's todaysChange is 0/0). Render yesterday's
  // close-vs-T-2 move so users see a real % change instead of a flat zero.
  if (snap && prevDayClose && prevDayClose > 0) {
    // prevRows[0] is the cache's latest bar. The cache's latest bar IS
    // yesterday's close (= prevDay.c) in the reset window, so T-2 lives at
    // prevRows[1]. Be defensive about cache freshness anyway: if prevRows[0]
    // somehow matches prevDay.c exactly use prevRows[1]; otherwise use
    // prevRows[0] as T-2.
    const cacheLatest = prevRows[0]?.close ?? null;
    const cacheSecond = prevRows[1]?.close ?? null;
    const tMinus2 = (cacheLatest !== null && Math.abs(cacheLatest - prevDayClose) < 0.0001)
      ? cacheSecond
      : cacheLatest;

    if (tMinus2 && tMinus2 > 0) {
      const change = prevDayClose - tMinus2;
      return {
        ticker,
        lastPrice: prevDayClose,
        previousClose: tMinus2,
        dailyChange: change,
        dailyChangePct: (change / tMinus2) * 100,
        // We're displaying yesterday's close, so the cache's latest business
        // date IS our "latest". When cache holds today's bar (rare in the
        // reset window but possible), latestBD is from prevRows[1].
        latestBusinessDate: (cacheLatest !== null && Math.abs(cacheLatest - prevDayClose) < 0.0001)
          ? (prevRows[1]?.business_date ?? "")
          : (prevRows[0]?.business_date ?? ""),
        previousBusinessDate: "",
        quoteTimestamp: snapshotBestTimestampISO(snap),
        source: "live",
      };
    }
    // No T-2 in cache. Don't emit a degenerate `change = 0` row — it'll get
    // filtered from the upsert anyway, and a missing row is honest: the next
    // PTR will warm the cache and the row will appear.
    // Fall through to Polygon-down paths in case cache has anything usable.
  }

  // === POLYGON-DOWN FALLBACK ===
  // Snapshot is null or unusable. Lean entirely on aggregate_cache.
  const supabaseLatestClose = prevRows[0]?.close ?? null;
  const supabasePrevClose = prevRows[1]?.close ?? null;
  const latestBD = prevRows[0]?.business_date ?? "";
  const previousBD = prevRows[1]?.business_date ?? "";

  if (supabaseLatestClose && supabaseLatestClose > 0 &&
      supabasePrevClose && supabasePrevClose > 0) {
    return {
      ticker,
      lastPrice: supabaseLatestClose,
      previousClose: supabasePrevClose,
      dailyChange: supabaseLatestClose - supabasePrevClose,
      dailyChangePct: ((supabaseLatestClose - supabasePrevClose) / supabasePrevClose) * 100,
      latestBusinessDate: latestBD,
      previousBusinessDate: previousBD,
      quoteTimestamp: null,
      source: "supabaseClose",
    };
  }

  // Cache has only one row. We could emit a flat zero-change row, but that's
  // exactly the kind of garbage that poisons quote_cache for the next 6h TTL.
  // Better to return null and let the next request retry.
  return null;
}

// MARK: - Cache write

async function upsertCache(dtos: MarketQuoteDTO[]): Promise<number> {
  // Filter degenerate rows BEFORE the upsert. They still flow back to iOS
  // in the response (the caller already collected them), but we won't
  // persist them — next request retries Polygon instead of serving zeros.
  // Shares the degenerate-row signature with the handler's read-side
  // derivation step (see `isDegeneratePayload`).
  const writable = dtos.filter((dto) => !isDegeneratePayload(dto));
  const skipped = dtos.length - writable.length;
  if (skipped > 0) {
    console.log(`[quotes] skipping ${skipped} degenerate rows from quote_cache upsert`);
  }
  if (writable.length === 0) return 0;

  // Sort by ticker before upserting. Postgres acquires row-level locks in
  // the order rows are presented; two concurrent /quotes invocations
  // working on overlapping ticker sets used to deadlock when one tried to
  // lock AAPL→MSFT while the other locked MSFT→AAPL. Sorting forces every
  // invocation to lock in the same alphabetical order, so concurrent
  // upserts queue cleanly instead of dead-locking.
  //
  // Cost: O(n log n) sort on the response set, ~25 tickers typical. Negligible.
  const sortedDtos = [...writable].sort((a, b) => a.ticker.localeCompare(b.ticker));
  const rows = sortedDtos.map((dto) => ({
    ticker: dto.ticker,
    payload: dto,
    fetched_at: new Date().toISOString(),
  }));
  const { error } = await admin().from("polygon_quote_cache").upsert(rows, { onConflict: "ticker" });
  if (error) throw error;
  return writable.length;
}

// MARK: - Aggregate cache warmup (PTR-only)

/// Fire-and-forget aggregate_cache seeding triggered by force=true (PTR).
///
/// For each requested ticker, ensures aggregate_cache holds enough bars
/// for fuseQuote's reset-window fallback (needs T-2). The window is small
/// (10 calendar days, generous for weekends + holidays).
///
/// PRE-CHECK (Option A): before fetching from Polygon, read the current
/// row for each ticker. If a row already exists AND covers a window AT
/// LEAST as wide as our 10-day target AND is within TTL, skip it. This is
/// critical: a user who's already loaded the 5y Stock Detail chart for
/// AAPL has a 5y aggregate_cache row; we MUST NOT narrow it back to 10
/// days. Coverage check semantics match /aggregates exactly.
async function warmAggregateCache(tickers: string[]): Promise<void> {
  if (tickers.length === 0) return;

  const today = todayISO_NY();
  const targetFrom = isoDaysAgo(10);
  const targetTo = today;
  const AGG_TTL_MS = 24 * 60 * 60 * 1000;

  // One read to learn the current state of every ticker we might need to seed.
  // We include `bars` length so we can detect empty-bars rows that pass the
  // date-range check but have no actual data (Polygon previously returned
  // nothing — e.g. ticker sent in wrong format before BRK-B→BRK.B fix).
  // Selecting only the count keeps the payload small.
  const { data, error } = await admin()
    .from("polygon_aggregate_cache")
    .select("ticker, from_date, to_date, fetched_at, bars")
    .in("ticker", tickers)
    .eq("adjusted", true);

  if (error) {
    console.error("[quotes] warm: aggregate_cache pre-check failed:", error);
    return;
  }

  const existing = new Map<string, { from_date: string; to_date: string; fetched_at: string; hasBars: boolean }>();
  for (const row of (data ?? []) as { ticker: string; from_date: string; to_date: string; fetched_at: string; bars: unknown }[]) {
    const hasBars = Array.isArray(row.bars) && row.bars.length > 0;
    existing.set(row.ticker, { from_date: row.from_date, to_date: row.to_date, fetched_at: row.fetched_at, hasBars });
  }

  // Decide who needs fetching. Skip any ticker whose existing row already
  // covers [targetFrom, targetTo], is fresh, AND has actual bars. An
  // empty-bars row would pass the covers check but isn't useful — re-fetch
  // it so the next fuseQuote call has T-2 to compute reset-window returns.
  const now = Date.now();
  const toFetch: string[] = [];
  for (const t of tickers) {
    const e = existing.get(t);
    if (!e) { toFetch.push(t); continue; }
    const covers = e.from_date <= targetFrom && e.to_date >= targetTo;
    const fresh = (now - Date.parse(e.fetched_at)) < AGG_TTL_MS;
    if (covers && fresh && e.hasBars) continue;
    toFetch.push(t);
  }

  if (toFetch.length === 0) {
    console.log(`[quotes] warm: all ${tickers.length} tickers already covered, nothing to fetch`);
    return;
  }

  console.log(`[quotes] warm: fetching ${toFetch.length}/${tickers.length} tickers (window ${targetFrom}→${targetTo})`);

  // Fan out per-ticker. Polygon's aggregates endpoint is per-ticker, no
  // batch alternative. We don't await the whole set — caller already moved
  // on; we just log results.
  const results = await Promise.allSettled(
    toFetch.map(async (ticker) => {
      // Compute the union with whatever the cache holds, so we never narrow
      // an existing wider window. EXCEPT when the existing row has no bars:
      // then its dates are noise (the row was written as a failed-fetch
      // sentinel), so we fetch the target window fresh.
      const e = existing.get(ticker);
      const useExisting = e !== undefined && e.hasBars;
      const fetchFrom = useExisting ? (e!.from_date < targetFrom ? e!.from_date : targetFrom) : targetFrom;
      const fetchTo   = useExisting ? (e!.to_date   > targetTo   ? e!.to_date   : targetTo  ) : targetTo;

      const bars = await fetchAggregates(ticker, fetchFrom, fetchTo, true);
      if (bars.length === 0) return { ticker, bars: 0 };

      const { error: upErr } = await admin()
        .from("polygon_aggregate_cache")
        .upsert({
          ticker,
          from_date: fetchFrom,
          to_date: fetchTo,
          adjusted: true,
          bars,
          fetched_at: new Date().toISOString(),
        }, { onConflict: "ticker,adjusted" });
      if (upErr) throw upErr;
      return { ticker, bars: bars.length };
    })
  );

  let ok = 0, fail = 0;
  for (const r of results) {
    if (r.status === "fulfilled") ok++;
    else { fail++; console.error("[quotes] warm: one ticker failed:", r.reason); }
  }
  console.log(`[quotes] warm: completed ok=${ok} fail=${fail}`);
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayISO_NY(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}