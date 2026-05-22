// _shared/market_state.ts
// Port of iOS CachePolicy.marketState — single source of truth for
// "is the US equity market open right now?" used to pick TTLs.
//
// Hours (US Eastern):
//   Pre-market:   04:00 – 09:30
//   Regular:      09:30 – 16:00
//   After-hours:  16:00 – 20:00
//
// Weekends are always closed. US market holidays are NOT modelled here —
// on a holiday the function will report "open" and burn 60s-cached calls
// against a closed exchange. Polygon will return last-trade timestamps
// from the previous session, so the data stays correct, just over-fetched.
// If holiday awareness ever matters, replace this with a calendar lookup.

export type MarketState = "open" | "extended" | "closed";

/// Get the market state for a given Date (defaults to now).
/// Computed in America/New_York wall-clock time regardless of server timezone.
export function marketState(at: Date = new Date()): MarketState {
  // Convert to ET via Intl.DateTimeFormat — Deno includes the full ICU
  // tz database, so this works in Edge Function isolates.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);

  // Weekend
  if (weekday === "Sat" || weekday === "Sun") return "closed";

  const hm = hour * 60 + minute;
  const open = 9 * 60 + 30;     // 09:30
  const close = 16 * 60;        // 16:00
  const preOpen = 4 * 60;       // 04:00
  const afterClose = 20 * 60;   // 20:00

  if (hm >= open && hm < close) return "open";
  if (hm >= preOpen && hm < open) return "extended";
  if (hm >= close && hm < afterClose) return "extended";
  return "closed";
}

/// Quote cache TTL by market state. The /quotes function reads this.
///
///   open      → 60s    — live prices move every few seconds
///   extended  → 5 min  — thin volume, big lulls
///   closed    → 6 hours — Polygon snapshot equals settled close
///
/// To change a TTL, edit this file and redeploy. No migration needed.
export function quoteCacheTTLSeconds(state: MarketState): number {
  switch (state) {
    case "open":     return 1;
    case "extended": return 300;
    case "closed":   return 6 * 60 * 60;
  }
}
