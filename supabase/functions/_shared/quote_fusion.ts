// _shared/quote_fusion.ts
// Shared quote-fusion logic used by both /quotes (on-demand, PTR) and
// /refresh_quote_cache (per-minute cron). Extracted verbatim from quotes.ts
// so the two paths can never drift: a single fuseQuote + upsertCache here is
// the one source of truth for how a Polygon snapshot + aggregate_cache bars
// become a persisted MarketQuoteDTO.

import {
  AggregateBarDTO,
  fetchAggregates,
  snapshotBestPrice,
  snapshotBestTimestampISO,
  snapshotBusinessDateNY,
  snapshotTodaysChange,
  SnapshotDTO,
} from "./polygon.ts";
import { admin } from "./supabase_admin.ts";

export interface MarketQuoteDTO {
  ticker: string;
  lastPrice: number;
  previousClose: number;
  dailyChange: number;
  dailyChangePct: number;
  latestBusinessDate: string;
  previousBusinessDate: string;
  quoteTimestamp: string | null;
  source: "live" | "supabaseClose";
}

export interface StockPriceRow {
  ticker: string;
  business_date: string;
  close: number | null;
}

/// Last 2-3 cached bars per ticker as the legacy {ticker, business_date,
/// close} shape fuseQuote consumes. Index 0 = latest, 1 = T-1, 2 = T-2.
export async function fetchPrevCloses(tickers: string[]): Promise<Record<string, StockPriceRow[]>> {
  const { data, error } = await admin()
    .from("polygon_aggregate_cache")
    .select("ticker, bars")
    .in("ticker", tickers)
    .eq("adjusted", true);

  if (error) {
    console.error("[quote_fusion] aggregate_cache read failed:", error);
    return {};
  }

  const grouped: Record<string, StockPriceRow[]> = {};
  for (const row of (data ?? []) as { ticker: string; bars: AggregateBarDTO[] }[]) {
    const bars = row.bars ?? [];
    if (bars.length === 0) continue;
    grouped[row.ticker] = bars
      .slice(-3)
      .reverse()
      .map((bar) => ({
        ticker: row.ticker,
        business_date: businessDateNY(bar.t),
        close: bar.c,
      }))
      .filter((r) => r.business_date !== "");
  }
  return grouped;
}

/// Convert an aggregate bar's epoch-ms timestamp to YYYY-MM-DD in NY.
function businessDateNY(ms: number): string {
  if (!ms || ms <= 0) return "";
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date(ms));
}

/// Build a MarketQuoteDTO from a Polygon snapshot and optionally the
/// ticker's last few cached closes. Happy path uses the snapshot alone;
/// reset-window and Polygon-down paths fall back to aggregate_cache bars.
export function fuseQuote(
  ticker: string,
  snap: SnapshotDTO | null,
  prevRows: StockPriceRow[],
): MarketQuoteDTO | null {
  const live = snap ? snapshotBestPrice(snap) : null;
  const snapBD = snap ? snapshotBusinessDateNY(snap) : null;
  const prevDayClose = snap?.prevDay?.c ?? null;
  const polyChange = snap ? snapshotTodaysChange(snap) : null;

  if (live && live > 0 && prevDayClose && prevDayClose > 0 && polyChange !== null) {
    return {
      ticker,
      lastPrice: live,
      previousClose: prevDayClose,
      dailyChange: live - prevDayClose,
      dailyChangePct: (live / prevDayClose - 1) * 100,
      latestBusinessDate: snapBD ?? "",
      previousBusinessDate: "",
      quoteTimestamp: snapshotBestTimestampISO(snap!),
      source: "live",
    };
  }

  if (snap && prevDayClose && prevDayClose > 0) {
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
        latestBusinessDate: (cacheLatest !== null && Math.abs(cacheLatest - prevDayClose) < 0.0001)
          ? (prevRows[1]?.business_date ?? "")
          : (prevRows[0]?.business_date ?? ""),
        previousBusinessDate: "",
        quoteTimestamp: snapshotBestTimestampISO(snap),
        source: "live",
      };
    }
  }

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
  return null;
}

/// Row carries no useful change signal — filtered before persisting.
function isDegeneratePayload(p: MarketQuoteDTO): boolean {
  return p.dailyChange === 0 &&
    p.dailyChangePct === 0 &&
    p.lastPrice === p.previousClose &&
    p.latestBusinessDate === "";
}

/// Upsert fused quotes into polygon_quote_cache, skipping degenerate rows
/// and sorting by ticker to keep concurrent upserts deadlock-free.
export async function upsertCache(dtos: MarketQuoteDTO[]): Promise<number> {
  const writable = dtos.filter((dto) => !isDegeneratePayload(dto));
  if (writable.length === 0) return 0;
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

/// Ensure aggregate_cache holds enough bars (≥T-2) for fuseQuote's
/// reset-window fallback. Pre-checks existing rows and never narrows a
/// wider cached window. Fans out per-ticker against Polygon aggregates.
export async function warmAggregateCache(tickers: string[]): Promise<void> {
  if (tickers.length === 0) return;

  const targetFrom = isoDaysAgo(10);
  const targetTo = todayISO_NY();
  const AGG_TTL_MS = 24 * 60 * 60 * 1000;

  const { data, error } = await admin()
    .from("polygon_aggregate_cache")
    .select("ticker, from_date, to_date, fetched_at, bars")
    .in("ticker", tickers)
    .eq("adjusted", true);

  if (error) {
    console.error("[quote_fusion] warm: pre-check failed:", error);
    return;
  }

  const existing = new Map<string, { from_date: string; to_date: string; fetched_at: string; hasBars: boolean }>();
  for (const row of (data ?? []) as { ticker: string; from_date: string; to_date: string; fetched_at: string; bars: unknown }[]) {
    const hasBars = Array.isArray(row.bars) && row.bars.length > 0;
    existing.set(row.ticker, { from_date: row.from_date, to_date: row.to_date, fetched_at: row.fetched_at, hasBars });
  }

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
  if (toFetch.length === 0) return;

  const results = await Promise.allSettled(
    toFetch.map(async (ticker) => {
      const e = existing.get(ticker);
      const useExisting = e !== undefined && e.hasBars;
      const fetchFrom = useExisting ? (e!.from_date < targetFrom ? e!.from_date : targetFrom) : targetFrom;
      const fetchTo = useExisting ? (e!.to_date > targetTo ? e!.to_date : targetTo) : targetTo;

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

  let fail = 0;
  for (const r of results) if (r.status === "rejected") { fail++; console.error("[quote_fusion] warm: ticker failed:", r.reason); }
  if (fail > 0) console.error(`[quote_fusion] warm: ${fail}/${toFetch.length} tickers failed`);
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