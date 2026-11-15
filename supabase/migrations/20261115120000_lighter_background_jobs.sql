-- Lighter background jobs (Emil, 2026-11-15). Supabase warned the project is running out of its Disk IO budget, and on
-- Nov 14 06:41-08:00 UTC the database stalled (cron "job startup timeout"). The real cause is memory: the instance has
-- 426 MB of RAM and swaps constantly (about 600 GB of system-disk reads a day); Postgres itself writes ~27 MB a day.
-- The fix for that is a bigger compute size. This trims the two jobs that ran every 5 minutes around the clock:
--   1. profile-scan-watchdog: every 10 minutes (a stuck Klaviyo profile scan is stale after 180 s, so it is still
--      picked up well within a run).
--   2. nudge-stalled-web-pipeline: every 10 minutes, and only when a web audit was created in the last 24 hours or a web
--      analysis job is still open. Every phase of the nudge only looks at audits from the last 24 hours, so on a quiet
--      day it had nothing to do; it was still the busiest query (about 280 ms a run, 288 runs a day).

select cron.alter_job(
  (select jobid from cron.job where jobname = 'profile-scan-watchdog'),
  schedule := '*/10 * * * *'
);

select cron.alter_job(
  (select jobid from cron.job where jobname = 'nudge-stalled-web-pipeline'),
  schedule := '*/10 * * * *',
  command := $cmd$
select public.nudge_stalled_web_pipeline()
where exists (select 1 from public.audits where audit_type = 'web' and created_at > now() - interval '24 hours')
   or exists (
     select 1 from public.audit_analysis_jobs j join public.audits a on a.id = j.audit_id
     where a.audit_type = 'web' and j.status in ('pending', 'running') and j.updated_at > now() - interval '24 hours'
   )
$cmd$
);
