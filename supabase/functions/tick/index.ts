// functions/tick/index.ts
// POST /functions/v1/tick — cron-triggered every minute.
//
// What it does, in six beats:
//   1. Bail if outside the tick window (pre-open, post-grace, weekends).
//   2. Read all enabled alerts (joined with users.subscription_tier so we
//      can skip alerts whose user's plan no longer permits the type).
//   3. Batch-fetch Polygon snapshots for the union of alert tickers.
//   4. Upsert each (ticker, ts) into price_snapshots with price + return + vol.
//   5. Run the evaluator registry per alert. Apply cooldown gate.
//   6. Bulk-insert alert_fires + notifications. Bump last_fired_at.
//
// Auth posture:
//   The cron migration calls this with the service-role bearer (fetched from
//   Supabase Vault). PostgREST therefore bypasses RLS via the auth header,
//   AND admin() bypasses RLS via the service-role key. Belt + braces.
//
// Error posture:
//   This is a cron-triggered job, not a user-facing endpoint. If anything
//   fails, log it and return 500 — pg_cron will retry on its next minute.
//   We don't try to recover mid-tick; the next tick gets a fresh attempt
//   with fresh data.

import { jsonResponse, errorResponse, preflight } from "../_shared/cors.ts";
import { admin } from "../_shared/supabase_admin.ts";
import {
  fetchSnapshotBatch,
  snapshotBestPrice,
  snapshotTodaysChange,
  snapshotBusinessDateNY,
  type SnapshotDTO,
} from "../_shared/polygon.ts";
import { evaluators, type EvalContext } from "../_shared/evaluators.ts";
import { isTickWindowOpen, tickWindowLabel } from "../_shared/market_window.ts";

// Row shapes
interface AlertRow {
  id: string;
  user_id: string;
  ticker: string;
  condition: Record<string, unknown>;
  condition_v: number;
  is_critical: boolean;
  cooldown_s: number;
  last_fired_at: string | null;
  users: { subscription_tier: string | null } | null;
}

interface PlanLimits {
  allowed_condition_types?: string[];
}

// Cached at module scope — plans rarely change, and even if they do, a
// minute of staleness is harmless. Reset on cold start, which Edge Function
// isolates do frequently enough.
let planLimitsCache: Map<string, PlanLimits> | null = null;

async function loadPlanLimits(): Promise<Map<string, PlanLimits>> {
  if (planLimitsCache) return planLimitsCache;
  const { data, error } = await admin()
    .from("user_plans")
    .select("name, limits");
  if (error) throw new Error(`plans load failed: ${error.message}`);
  const map = new Map<string, PlanLimits>();
  for (const row of data ?? []) {
    map.set(row.name as string, (row.limits as PlanLimits) ?? {});
  }
  planLimitsCache = map;
  return map;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const startedAt = Date.now();
  const now = new Date();
  const nowIso = now.toISOString();

  // ────────────────────────────────────────────────────────────────
  // 1. Window check
  // ────────────────────────────────────────────────────────────────
  if (!isTickWindowOpen(now)) {
    const label = tickWindowLabel(now);
    return jsonResponse({ ok: true, skipped: label, duration_ms: Date.now() - startedAt });
  }

  try {
    // ────────────────────────────────────────────────────────────────
    // 2. Pull enabled alerts, then each user's plan name in a second query
    // ────────────────────────────────────────────────────────────────
    // alerts.user_id has its FK against auth.users(id) — not public.users(id) —
    // so PostgREST can't auto-embed public.users in one query. We do two
    // queries and merge in TypeScript. Cost is one extra round-trip per
    // tick (a few ms); avoids touching PR 1's FK structure.
    const { data: rawAlerts, error: alertsErr } = await admin()
      .from("user_alerts")
      .select("id, user_id, ticker, condition, condition_v, is_critical, cooldown_s, last_fired_at")
      .eq("enabled", true);

    if (alertsErr) throw new Error(`alerts load failed: ${alertsErr.message}`);

    const rawAlertList = (rawAlerts ?? []) as Array<Omit<AlertRow, "users">>;

    if (rawAlertList.length === 0) {
      return jsonResponse({
        ok: true, evaluated: 0, fires: 0, duration_ms: Date.now() - startedAt,
      });
    }

    // Second query: each distinct user's subscription_tier.
    const userIds = [...new Set(rawAlertList.map((a) => a.user_id))];
    const { data: userRows, error: usersErr } = await admin()
      .from("users")
      .select("id, subscription_tier")
      .in("id", userIds);
    if (usersErr) throw new Error(`users load failed: ${usersErr.message}`);

    const tierByUser = new Map<string, string>();
    for (const u of (userRows ?? []) as Array<{ id: string; subscription_tier: string | null }>) {
      tierByUser.set(u.id, u.subscription_tier ?? "free");
    }

    // Merge: alerts whose user has no row in public.users (shouldn't happen
    // post-PR 4, but defensive) default to "free".
    const alerts: AlertRow[] = rawAlertList.map((a) => ({
      ...a,
      users: { subscription_tier: tierByUser.get(a.user_id) ?? "free" },
    }));

    // Filter at eval time by plan-allowed types. The DB trigger blocks new
    // inserts that don't match the plan, but a tier downgrade after an
    // alert was created could leave a stale row. Skip rather than fire.
    const planLimits = await loadPlanLimits();
    const eligibleAlerts = alerts.filter((a) => {
      const tier = a.users?.subscription_tier ?? "free";
      const allowed = planLimits.get(tier)?.allowed_condition_types ?? [];
      const condType = a.condition?.type as string;
      return allowed.length === 0 || allowed.includes(condType);
    });

    // ────────────────────────────────────────────────────────────────
    // 3. Batch-fetch Polygon snapshots
    // ────────────────────────────────────────────────────────────────
    const tickers = [...new Set(eligibleAlerts.map((a) => a.ticker))];
    let snapshots: Record<string, SnapshotDTO> = {};
    try {
      snapshots = await fetchSnapshotBatch(tickers);
    } catch (e) {
      console.error("[tick] polygon snapshot failed:", e);
      return errorResponse((e as Error).message ?? "polygon failed", 502);
    }

    // ────────────────────────────────────────────────────────────────
    // 4. Persist price_snapshots
    // ────────────────────────────────────────────────────────────────
    const snapshotRows: Array<{
      ticker: string; ts: string; price: number;
      price_return: number | null; volume: number | null;
    }> = [];

    for (const t of tickers) {
      const snap = snapshots[t];
      if (!snap) continue;
      const best = snapshotBestPrice(snap);
      if (best === null || best.price <= 0) continue;
      const price = best.price;
      const change = snapshotTodaysChange(snap);
      snapshotRows.push({
        ticker: t,
        ts: nowIso,
        price,
        price_return: change?.changePct ?? null,
        volume: snap.day?.v ?? null,
      });
    }

    if (snapshotRows.length > 0) {
      const { error: snapErr } = await admin()
        .from("polygon_price_snapshots")
        .upsert(snapshotRows, { onConflict: "ticker,ts" });
      if (snapErr) throw new Error(`price_snapshots upsert failed: ${snapErr.message}`);
    }

    // ────────────────────────────────────────────────────────────────
    // 5. Evaluate
    // ────────────────────────────────────────────────────────────────
    // Today's business date in NY — derived once from the first snapshot
    // we have. Falls back to the system's NY-projected date if no
    // snapshot carries a usable timestamp.
    const todayBusinessDate = deriveTodayBusinessDate(snapshots) ?? todayNY(now);

    const fires: Array<Record<string, unknown>> = [];
    const notifications: Array<Record<string, unknown>> = [];
    const alertIdsToBumpFireTime: string[] = [];

    for (const alert of eligibleAlerts) {
      const snap = snapshots[alert.ticker];
      if (!snap) continue;
      const best = snapshotBestPrice(snap);
      if (best === null || best.price <= 0) continue;
      const price = best.price;
      const change = snapshotTodaysChange(snap);

      const evaluator = evaluators[alert.condition.type as string];
      if (!evaluator) {
        console.warn(`[tick] no evaluator for type=${alert.condition.type} alert=${alert.id}`);
        continue;
      }

      const ctx: EvalContext = {
        currentPrice: price,
        todaysChangePct: change?.changePct ?? null,
        todayBusinessDate,
      };

      let result;
      try {
        result = await evaluator(alert.ticker, alert.condition, ctx);
      } catch (e) {
        console.error(`[tick] evaluator threw for alert=${alert.id}:`, e);
        continue;
      }
      if (!result.fired) continue;

      // Cooldown gate. cooldown_s is enforced by the DB trigger to be ≥ 60s,
      // so we always have a meaningful gap to check against.
      if (alert.last_fired_at) {
        const since = (now.getTime() - new Date(alert.last_fired_at).getTime()) / 1000;
        if (since < alert.cooldown_s) continue;
      }

      fires.push({
        alert_id: alert.id,
        fired_at: nowIso,
        trigger_price: price,
        reference_price: result.referencePrice ?? null,
        move_pct: result.movePct ?? null,
        context: result.context ?? {},
      });

      notifications.push({
        user_id: alert.user_id,
        kind: "single",
        payload: {
          alert_id: alert.id,
          ticker: alert.ticker,
          condition: alert.condition,
          trigger_price: price,
          reference_price: result.referencePrice ?? null,
          reference_date: result.referenceDate ?? null,
          reference_days_ago: result.referenceDaysAgo ?? null,
          move_pct: result.movePct ?? null,
          is_critical: alert.is_critical,
        },
        status: "pending",
        scheduled_for: nowIso,
      });

      alertIdsToBumpFireTime.push(alert.id);
    }

    // ────────────────────────────────────────────────────────────────
    // 6. Bulk-persist
    // ────────────────────────────────────────────────────────────────
    if (fires.length > 0) {
      const { error: firesErr } = await admin().from("user_alert_fires").insert(fires);
      if (firesErr) throw new Error(`alert_fires insert failed: ${firesErr.message}`);
    }
    if (notifications.length > 0) {
      const { error: notifErr } = await admin().from("user_notifications").insert(notifications);
      if (notifErr) throw new Error(`notifications insert failed: ${notifErr.message}`);
    }
    if (alertIdsToBumpFireTime.length > 0) {
      const { error: updErr } = await admin()
        .from("user_alerts")
        .update({ last_fired_at: nowIso })
        .in("id", alertIdsToBumpFireTime);
      if (updErr) throw new Error(`alerts update failed: ${updErr.message}`);
    }

    return jsonResponse({
      ok: true,
      window: tickWindowLabel(now),
      alerts_evaluated: eligibleAlerts.length,
      alerts_skipped_tier: alerts.length - eligibleAlerts.length,
      tickers_priced: snapshotRows.length,
      fires: fires.length,
      duration_ms: Date.now() - startedAt,
    });

  } catch (err) {
    console.error("[tick] failed:", err);
    return errorResponse((err as Error).message ?? "tick failed", 500);
  }
});

// MARK: - helpers

/// Find today's business date from the first usable snapshot. Polygon
/// timestamps land in NY business date via snapshotBusinessDateNY.
function deriveTodayBusinessDate(snaps: Record<string, SnapshotDTO>): string | null {
  for (const t of Object.keys(snaps)) {
    const bd = snapshotBusinessDateNY(snaps[t]);
    if (bd) return bd;
  }
  return null;
}

/// NY-projected current date, fallback when no snapshot has a timestamp.
function todayNY(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
}