-- 023_alerts_dispatch_cron.sql
-- Phase 7a — Server-side push alerts.
--
-- pg_cron schedule for /dispatch. Identical pattern to alerts_tick in
-- 021_alerts_cron.sql — reuses the same vault secret (alerts_service_key).
--
-- ⚠ ONE MANUAL STEP BEFORE PUSHING:
--   Find and replace REPLACE_WITH_PROJECT_REF below with your project ref.
--   Same value you used in 021. Studio → Settings → API → Project URL.

-- Idempotent: drop any pre-existing alerts_dispatch job.
DO $$
DECLARE jid bigint;
BEGIN
  FOR jid IN
    SELECT jobid FROM cron.job WHERE jobname = 'alerts_dispatch'
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END$$;

-- Every minute. /dispatch is cheap when the queue is empty (one indexed
-- query that returns zero rows) so the same cadence as /tick is fine.
SELECT cron.schedule(
  'alerts_dispatch',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://fiuaznpaogdzuxunnrhv.supabase.co/functions/v1/dispatch',
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

-- Verification (run manually after `supabase db push`):
--   SELECT jobname, schedule, active FROM cron.job
--   WHERE jobname IN ('alerts_tick', 'alerts_prune', 'alerts_dispatch');
--   Expect: 3 rows, all active=true.
