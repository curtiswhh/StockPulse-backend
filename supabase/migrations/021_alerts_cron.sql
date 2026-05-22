-- 021_alerts_cron.sql
-- Phase 7a — Server-side push alerts.
--
-- pg_cron schedules for the alerts feature:
--   1. alerts_tick   — every minute. Calls /functions/v1/tick which fetches
--                      prices, evaluates alerts, stages fires + notifications.
--                      The function itself short-circuits outside trading
--                      hours (see _shared/market_window.ts), so we keep
--                      the cron at `* * * * *` and avoid DST gymnastics.
--   2. alerts_prune  — daily at 03:00 UTC. Deletes price_snapshots > 14
--                      days old (function from 019_alerts_pruning.sql).
--
-- The /dispatch cron is added in PR 3, not here.
--
-- ────────────────────────────────────────────────────────────────────────
-- ⚠ TWO MANUAL STEPS REQUIRED BEFORE PUSHING THIS MIGRATION
-- ────────────────────────────────────────────────────────────────────────
--
-- STEP A — Seed the service-role key into Supabase Vault.
--   Get the key from Studio → Settings → API → service_role (NOT anon).
--   Then run ONCE in the Supabase SQL editor:
--
--     SELECT vault.create_secret(
--       '<paste-service-role-key-here>',
--       'alerts_service_key',
--       'Service-role bearer for alerts cron jobs (PR 2+)'
--     );
--
--   Rotation later = a single UPDATE to vault.secrets. Cron picks it up on
--   its next tick. No migration redeploy.
--
-- STEP B — Find and replace the project URL placeholder below.
--   Search for REPLACE_WITH_PROJECT_REF (two occurrences) and replace with
--   your actual project ref. Get it from Studio → Settings → API → Project URL.
--   Example: https://abc123xyz.supabase.co
--
--   Why hardcoded: the URL is public (anyone can call your edge function;
--   auth is the bearer). Templating it via Postgres settings has been
--   unreliable across Supabase platform versions. Hardcoding is what
--   pulsealert-backend and most Supabase cron examples do.
--
-- ────────────────────────────────────────────────────────────────────────

-- Idempotent: unschedule any pre-existing job by these names so the
-- migration can be re-run safely. pg_cron raises if SCHEDULE meets an
-- existing name. Wrapping in DO + loop tolerates a missing job (which
-- is what `cron.unschedule` raises on otherwise).
DO $$
DECLARE jid bigint;
BEGIN
  FOR jid IN
    SELECT jobid FROM cron.job WHERE jobname IN ('alerts_tick', 'alerts_prune')
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END$$;

-- ────────────────────────────────────────────────────────────────────────
-- 1. alerts_tick — every minute, calls /functions/v1/tick
-- ────────────────────────────────────────────────────────────────────────
SELECT cron.schedule(
  'alerts_tick',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://fiuaznpaogdzuxunnrhv.supabase.co/functions/v1/tick',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'alerts_service_key'
        LIMIT 1
      )
    ),
    body    := '{}'::jsonb
  );
  $cron$
);

-- ────────────────────────────────────────────────────────────────────────
-- 2. alerts_prune — daily at 03:00 UTC
-- ────────────────────────────────────────────────────────────────────────
-- This calls the prune function directly (no edge function trip), so it
-- doesn't need the vault key. Lighter and faster.
SELECT cron.schedule(
  'alerts_prune',
  '0 3 * * *',
  $cron$ SELECT public.prune_old_price_snapshots(); $cron$
);

-- ────────────────────────────────────────────────────────────────────────
-- Verification — run manually in the SQL editor after `supabase db push`:
--
--   SELECT jobname, schedule, active FROM cron.job
--   WHERE jobname IN ('alerts_tick', 'alerts_prune');
--   Expect: 2 rows, both active=true.
--
--   SELECT * FROM cron.job_run_details
--   WHERE jobname = 'alerts_tick'
--   ORDER BY start_time DESC LIMIT 5;
--   Expect (during market hours): rows with status='succeeded' and a
--   short return_message; (outside market hours): same, but the
--   function returned {skipped: <reason>}.
-- ────────────────────────────────────────────────────────────────────────
