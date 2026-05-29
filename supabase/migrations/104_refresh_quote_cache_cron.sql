-- 104_refresh_quote_cache_cron.sql
-- Per-minute warm of polygon_quote_cache so the iOS watchlist shows
-- minute-fresh prices without pull-to-refresh.
--
-- Calls /functions/v1/refresh_quote_cache every minute. The function
-- short-circuits outside the trading window (same _shared/market_window.ts
-- gate as /tick: 09:30 -> 16:20 ET, weekdays), so the cron stays at
-- `* * * * *` with no DST handling.
--
-- Reuses the 'alerts_service_key' vault secret seeded in 021_alerts_cron.sql.
-- No new manual steps required if 021 is already applied.

DO $$
DECLARE jid bigint;
BEGIN
  FOR jid IN
    SELECT jobid FROM cron.job WHERE jobname = 'refresh_quote_cache'
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END$$;

SELECT cron.schedule(
  'refresh_quote_cache',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://fiuaznpaogdzuxunnrhv.supabase.co/functions/v1/refresh_quote_cache',
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

-- Verification — run manually after `supabase db push`:
--
--   SELECT jobname, schedule, active FROM cron.job
--   WHERE jobname = 'refresh_quote_cache';
--   Expect: 1 row, active=true.
--
--   SELECT status, return_message, start_time FROM cron.job_run_details
--   WHERE jobname = 'refresh_quote_cache'
--   ORDER BY start_time DESC LIMIT 5;
--   Expect (market hours): status='succeeded', body like {"refreshed": N};
--          (outside hours): status='succeeded', body like {"skipped": "..."}.
