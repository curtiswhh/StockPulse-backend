-- 102_watchlists_pruning.sql
-- Nightly prune of soft-deleted watchlist tombstones.
--
-- Soft-deleted rows (deleted_at IS NOT NULL) are kept on disk so that a
-- device which still has the row cached locally learns it was deleted
-- elsewhere, rather than resurrecting it on its next sync. Once enough
-- time has passed that every device has re-synced, the tombstone is dead
-- weight and can be hard-deleted.
--
-- 30 days is the retention window: comfortably longer than any realistic
-- gap between a user opening the app on two devices, so a stale device
-- won't re-push a row we pruned. If you observe resurrections, lengthen
-- the interval below.
--
-- Mirrors the pattern in 019_alerts_pruning.sql (SECURITY DEFINER prune
-- function) + 021_alerts_cron.sql (idempotent unschedule, then schedule).

CREATE OR REPLACE FUNCTION prune_old_watchlist_tombstones()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  DELETE FROM watchlists
  WHERE deleted_at IS NOT NULL
    AND deleted_at < now() - interval '30 days';
END;
$$;

COMMENT ON FUNCTION prune_old_watchlist_tombstones IS
  'Hard-deletes soft-deleted watchlist rows older than 30 days. Wired to pg_cron below.';

-- Idempotent: drop any pre-existing job by this name so the migration can
-- be re-run safely (cron.schedule raises if the name already exists, and
-- cron.unschedule raises if it does not — the loop tolerates both).
DO $$
DECLARE jid bigint;
BEGIN
  FOR jid IN
    SELECT jobid FROM cron.job WHERE jobname = 'watchlists_prune'
  LOOP
    PERFORM cron.unschedule(jid);
  END LOOP;
END$$;

-- watchlists_prune — daily at 03:30 UTC.
-- Calls the prune function directly (no edge-function trip), so it needs
-- no vault key. Offset 30 min from alerts_prune (03:00) to avoid both
-- heavy deletes firing at the same instant.
SELECT cron.schedule(
  'watchlists_prune',
  '30 3 * * *',
  $cron$ SELECT public.prune_old_watchlist_tombstones(); $cron$
);

-- ────────────────────────────────────────────────────────────────────────
-- Verification — run manually in the SQL editor after `supabase db push`:
--
--   SELECT jobname, schedule, active FROM cron.job
--   WHERE jobname = 'watchlists_prune';
--   Expect: 1 row, active=true.
--
--   -- Run the prune on demand to confirm it works:
--   SELECT public.prune_old_watchlist_tombstones();
-- ────────────────────────────────────────────────────────────────────────
