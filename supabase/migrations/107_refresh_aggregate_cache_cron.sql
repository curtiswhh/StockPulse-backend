-- 107_refresh_aggregate_cache_cron.sql
-- Daily pre-open refresh of polygon_aggregate_cache for the union of every
-- enabled-alert stock ticker. The N-day alert evaluator (price_move_nd)
-- reads its reference close from this cache; this cron keeps that data warm
-- across all alert tickers each day. Same-minute availability for a newly
-- added alert is handled by /tick's lazy warm, not by this cron.
--
-- Cadence: once daily at 13:30 UTC — before the 09:30 ET open year-round
-- (08:30 ET during EDT, earlier under EST), which is all that matters since
-- /tick only runs inside the trading window. Daily OHLC settles overnight,
-- so one run per day suffices.
--
-- Reuses the 'alerts_service_key' vault secret seeded in 021_alerts_cron.sql.
-- No new manual steps if 021 is already applied.

DO $$
DECLARE jid bigint;
BEGIN
  FOR jid IN
    SELECT jobid FROM cron.job WHERE jobname = 'refresh_aggregate_cache'
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END$$;

SELECT cron.schedule(
  'refresh_aggregate_cache',
  '30 13 * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://fiuaznpaogdzuxunnrhv.supabase.co/functions/v1/refresh_aggregate_cache',
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
--   WHERE jobname = 'refresh_aggregate_cache';
--   Expect: 1 row, schedule='30 13 * * *', active=true.
--
--   SELECT status, return_message, start_time FROM cron.job_run_details
--   WHERE jobname = 'refresh_aggregate_cache'
--   ORDER BY start_time DESC LIMIT 5;
--   Expect: status='succeeded', body like {"ok":true,"tickers":N,...}.
