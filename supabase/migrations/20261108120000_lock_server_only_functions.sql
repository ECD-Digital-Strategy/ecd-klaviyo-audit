-- Audit 2026-11-08: two SECURITY DEFINER functions were callable with the app's
-- public (anon) key and by any signed-in user, though only the server uses them:
--  - claim_profile_scan_job: called by klaviyo_fetch_snapshot with the service role;
--  - mark_expired_proposals_lost: called by the cron job mark-expired-proposals-lost
--    (runs as postgres).
-- Neither is called from the browser (grep src/), so only the server may run them.
revoke execute on function public.claim_profile_scan_job(uuid) from public, anon, authenticated;
revoke execute on function public.mark_expired_proposals_lost() from public, anon, authenticated;
grant execute on function public.claim_profile_scan_job(uuid) to service_role;
grant execute on function public.mark_expired_proposals_lost() to service_role;
