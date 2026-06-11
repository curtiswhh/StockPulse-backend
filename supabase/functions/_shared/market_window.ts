// _shared/market_window.ts
// Decides whether /tick should run a given minute.
//
// Builds on _shared/market_state.ts (which knows pre-market / regular /
// extended / closed) but adds a /tick-specific concept: a 15-minute "trailing
// grace window" after the 4pm ET close (last run 16:15 inclusive).
//
// Why the grace window: the feed is 15-min delayed, so a fetch at 16:15 ET
// is the first one that contains everything up to the 16:00 close — final
// prints, late corrections, day-summary fields populating in Polygon. We
// want to catch those for evaluators that depend on `todaysChangePerc`,
// then go quiet until the next session.
//
// All other hours (pre-market < 09:30, after 16:15, weekends): /tick returns
// {skipped: "outside_window"} without making a Polygon call or a DB write.
// Polygon quota is preserved, the function still runs (cron stays simple at
// `* * * * *`, no DST gymnastics).

const REGULAR_OPEN_MIN = 9 * 60 + 30;  // 09:30 ET
const REGULAR_CLOSE_MIN = 16 * 60;      // 16:00 ET
const GRACE_END_MIN = 16 * 60 + 16; // exclusive bound — last run 16:15 ET (15-min delayed feed covers the 16:00 close)

/// Returns true if /tick should run right now. False otherwise.
/// `at` defaults to now; injectable for testing.
export function isTickWindowOpen(at: Date = new Date()): boolean {
  // Project to ET wall-clock. Deno includes the full ICU tz db, so this
  // works inside Edge Function isolates.
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

  // US holidays are NOT modeled here — same posture as the existing
  // _shared/market_state.ts. A holiday will burn ~390 zero-result Polygon
  // calls and an equal number of DB writes; Polygon returns last-session
  // values, so evaluators see flat data and fire nothing. If quota becomes
  // an issue, swap this for a business_dates lookup.
  if (weekday === "Sat" || weekday === "Sun") return false;

  const nowMin = hour * 60 + minute;
  return nowMin >= REGULAR_OPEN_MIN && nowMin < GRACE_END_MIN;
}

/// Diagnostic label for logging — useful when /tick's response shows
/// {skipped: <reason>}.
export function tickWindowLabel(at: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(at);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  if (weekday === "Sat" || weekday === "Sun") return "weekend";

  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const nowMin = hour * 60 + minute;

  if (nowMin < REGULAR_OPEN_MIN) return "pre_open";
  if (nowMin < REGULAR_CLOSE_MIN) return "regular";
  if (nowMin < GRACE_END_MIN) return "grace";
  return "after_grace";
}