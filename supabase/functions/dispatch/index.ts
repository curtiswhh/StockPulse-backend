// functions/dispatch/index.ts
// POST /functions/v1/dispatch — cron-triggered every minute.
//
// Drains the notifications table:
//   1. Pull all pending rows whose scheduled_for has passed (joined with the
//      user's apns_token and apns_env).
//   2. Bucket by user, count today's sent for daily_cap enforcement.
//   3. For each row: skip if no token; otherwise send via APNs.
//   4. Map the APNs result to a status transition:
//        - sent          → status='sent', sent_at=now()
//        - bad_token     → status='dropped', clear users.apns_token
//        - rate_limited  → leave pending, will retry next tick
//        - expired_jwt   → leave pending, JWT cache cleared, will retry
//        - transient/5xx → leave pending, will retry next tick
//        - fatal/other   → status='dropped'
//
// Daily cap: users.daily_cap (default 10). Counts today's sent notifications
// in UTC. is_critical=true bypasses the cap. Over-cap non-critical rows go
// to status='dropped' (PR 1 didn't column cap_behavior, so hardcoded "drop"
// matches the documented PR 3 plan).
//
// Concurrency note: if a tick takes >60s and the next tick starts before
// it finishes, a notification could in theory be processed twice. v1
// accepts this — worst case is a duplicate push. If we ever see it
// happen in practice, add a claimed_at column and SKIP LOCKED. Not now.
//
// Quiet hours / bundling / digest: NOT implemented. Deferred per PR 1
// design call. /dispatch in v1 is "every pending notification gets a push,
// gated only by daily_cap + is_critical".

import { jsonResponse, errorResponse, preflight } from "../_shared/cors.ts";
import { admin } from "../_shared/supabase_admin.ts";
import { sendApns, type ApnsResult } from "../_shared/apns.ts";

// ============================================================
// Types
// ============================================================

interface PendingNotification {
  id: string;
  user_id: string;
  kind: "single" | "bundle" | "digest";
  payload: NotificationPayload;
  scheduled_for: string;
  created_at: string;
}

interface NotificationPayload {
  alert_id?: string;
  ticker?: string;
  condition?: Record<string, unknown>;
  trigger_price?: number;
  reference_price?: number | null;
  move_pct?: number | null;
  is_critical?: boolean;
}

interface UserPushInfo {
  id: string;
  apns_token: string | null;
  apns_env: "production" | "sandbox" | null;
  daily_cap: number;
}

// ============================================================
// Handler
// ============================================================

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST")    return errorResponse("Method not allowed", 405);

  const startedAt = Date.now();
  const now = new Date();
  const nowIso = now.toISOString();

  try {
    // ────────────────────────────────────────────────────────────────
    // 1. Pull pending notifications.
    // ────────────────────────────────────────────────────────────────
    // Limit is a soft guard against runaway batches — 200 covers typical
    // load. Anything beyond gets picked up next minute.
    const { data: pending, error: pendingErr } = await admin()
      .from("notifications")
      .select("id, user_id, kind, payload, scheduled_for, created_at")
      .eq("status", "pending")
      .lte("scheduled_for", nowIso)
      .order("created_at", { ascending: true })
      .limit(200);

    if (pendingErr) throw new Error(`pending load failed: ${pendingErr.message}`);
    const queue = (pending ?? []) as PendingNotification[];

    if (queue.length === 0) {
      return jsonResponse({
        ok: true, sent: 0, dropped: 0, retried: 0, duration_ms: Date.now() - startedAt,
      });
    }

    // ────────────────────────────────────────────────────────────────
    // 2. Load each distinct user's push token + cap.
    // ────────────────────────────────────────────────────────────────
    const userIds = [...new Set(queue.map((n) => n.user_id))];
    const { data: userRows, error: usersErr } = await admin()
      .from("users")
      .select("id, apns_token, apns_env, daily_cap")
      .in("id", userIds);
    if (usersErr) throw new Error(`users load failed: ${usersErr.message}`);

    const userById = new Map<string, UserPushInfo>();
    for (const u of (userRows ?? []) as UserPushInfo[]) {
      userById.set(u.id, u);
    }

    // ────────────────────────────────────────────────────────────────
    // 3. Count today's sent per user (for daily_cap enforcement).
    //    "Today" = UTC. Bundling-aware: kind='single' AND kind='bundle'
    //    both count; kind='bundled_into' (a status, not a kind) doesn't
    //    apply here.
    // ────────────────────────────────────────────────────────────────
    const todayStart = new Date(now);
    todayStart.setUTCHours(0, 0, 0, 0);

    const sentTodayByUser = new Map<string, number>();
    for (const uid of userIds) {
      const { count, error: cErr } = await admin()
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("user_id", uid)
        .eq("status", "sent")
        .gte("sent_at", todayStart.toISOString());
      if (cErr) {
        console.warn(`[dispatch] count failed for user=${uid}:`, cErr.message);
        sentTodayByUser.set(uid, 0);
      } else {
        sentTodayByUser.set(uid, count ?? 0);
      }
    }

    // ────────────────────────────────────────────────────────────────
    // 4. Process each notification.
    // ────────────────────────────────────────────────────────────────
    const stats = { sent: 0, dropped: 0, retried: 0, no_token: 0, over_cap: 0 };

    for (const n of queue) {
      const u = userById.get(n.user_id);

      // 4a. No user row, or no token → drop with reason.
      if (!u) {
        await markDropped(n.id, "no_user_row");
        stats.dropped++;
        continue;
      }
      if (!u.apns_token) {
        await markDropped(n.id, "no_apns_token");
        stats.dropped++;
        stats.no_token++;
        continue;
      }

      const isCritical = n.payload.is_critical === true;
      const sentToday = sentTodayByUser.get(n.user_id) ?? 0;

      // 4b. Daily cap (non-critical only).
      if (!isCritical && sentToday >= u.daily_cap) {
        await markDropped(n.id, "daily_cap_exceeded");
        stats.dropped++;
        stats.over_cap++;
        continue;
      }

      // 4c. Build + send the push.
      const apnsPayload = formatPayload(n);
      const result = await sendApns(u.apns_token, {
        ...apnsPayload,
        env: u.apns_env ?? "production",
      });

      // 4d. Map result → status transition.
      await applyResult(n.id, n.user_id, result, stats, sentTodayByUser);
    }

    return jsonResponse({
      ok: true,
      processed: queue.length,
      sent: stats.sent,
      dropped: stats.dropped,
      retried: stats.retried,
      no_token: stats.no_token,
      over_cap: stats.over_cap,
      duration_ms: Date.now() - startedAt,
    });

  } catch (err) {
    console.error("[dispatch] failed:", err);
    return errorResponse((err as Error).message ?? "dispatch failed", 500);
  }
});

// ============================================================
// Helpers
// ============================================================

/// Build a user-facing push from a notification row's payload.
function formatPayload(n: PendingNotification): { title: string; body: string; data: Record<string, unknown> } {
  // v1 only handles kind='single'. bundle / digest land in PR 6.
  const p = n.payload;
  const ticker = p.ticker ?? "?";
  const move = p.move_pct ?? 0;
  const arrow = move > 0 ? "up" : "down";
  const abs = Math.abs(move).toFixed(2);

  const trigger = p.trigger_price?.toFixed(2) ?? "—";
  const ref = p.reference_price?.toFixed(2) ?? "—";

  return {
    title: `${ticker} ${arrow} ${abs}%`,
    body: `Now $${trigger} · was $${ref}`,
    data: {
      notification_id: n.id,
      alert_id: p.alert_id,
      ticker: p.ticker,
      type: "price_move",
    },
  };
}

/// Apply the APNs result to the notification row. Updates stats + the
/// in-memory sent-today counter so subsequent rows in the same tick
/// see the correct count.
async function applyResult(
  notificationId: string,
  userId: string,
  result: ApnsResult,
  stats: { sent: number; dropped: number; retried: number },
  sentTodayByUser: Map<string, number>,
): Promise<void> {
  switch (result.kind) {
    case "sent": {
      const { error } = await admin()
        .from("notifications")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", notificationId);
      if (error) console.error(`[dispatch] mark sent failed:`, error);
      stats.sent++;
      sentTodayByUser.set(userId, (sentTodayByUser.get(userId) ?? 0) + 1);
      return;
    }
    case "bad_token": {
      // The token is dead. Clear it from users so we stop trying. iOS will
      // re-register on next launch.
      await admin()
        .from("users")
        .update({ apns_token: null })
        .eq("id", userId);
      await markDropped(notificationId, `apns_${result.reason}`);
      stats.dropped++;
      return;
    }
    case "rate_limited":
    case "expired_jwt":
    case "transient": {
      // Leave the row pending. Next tick retries.
      stats.retried++;
      return;
    }
    case "fatal": {
      console.error(`[dispatch] APNs fatal (status=${result.status}): ${result.body}`);
      await markDropped(notificationId, `apns_${result.status}`);
      stats.dropped++;
      return;
    }
  }
}

/// Mark a notification row as dropped. Drops are terminal — the user
/// will never see this push. We store the reason in payload._drop_reason
/// for diagnostics, alongside the original payload.
async function markDropped(notificationId: string, reason: string): Promise<void> {
  // Read-modify-write because we want to preserve the original payload
  // while annotating it. Single row, single tick — fine.
  const { data, error: readErr } = await admin()
    .from("notifications")
    .select("payload")
    .eq("id", notificationId)
    .single();
  if (readErr) {
    console.error(`[dispatch] markDropped read failed:`, readErr);
    // Fall through to the update anyway — losing the reason annotation
    // is better than not marking the row dropped.
  }
  const newPayload = { ...(data?.payload ?? {}), _drop_reason: reason };

  const { error: updErr } = await admin()
    .from("notifications")
    .update({ status: "dropped", payload: newPayload })
    .eq("id", notificationId);
  if (updErr) console.error(`[dispatch] markDropped update failed:`, updErr);
}
