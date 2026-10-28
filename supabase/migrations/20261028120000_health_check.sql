-- Health check (Emil, 2026-10-28): an hourly look at the few things that break
-- silently and matter, emailed only when something is wrong (health_check function).
-- Xero losing its connection, a scheduled job or its HTTP call failing (a stale or
-- rotated key looks exactly like this), and audit work stuck or timed out. Missing
-- Shopify scopes and the like are left to the audit run that needs them.

-- The hourly job's own secret, like the other cron jobs: generated here, read only
-- by the service role, so it never has to be pasted anywhere.
create table if not exists public.health_check_cron_secret (
  id text primary key default 'default',
  secret text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
alter table public.health_check_cron_secret enable row level security;
insert into public.health_check_cron_secret (id) values ('default') on conflict do nothing;

-- What has been reported, so one problem is emailed at most once a day. A key
-- that is no longer a problem is deleted, so it is emailed again if it comes back.
create table if not exists public.health_alert_state (
  key text primary key,
  title text not null,
  first_seen timestamptz not null default now(),
  last_sent timestamptz
);
alter table public.health_alert_state enable row level security;

-- Failed scheduled jobs and failed calls they made, recently. cron and net are not
-- reachable through the API, so the function reads them through this. The health
-- check itself is left out, so it cannot report on itself.
create or replace function public.health_cron_signals(p_since interval default interval '2 hours')
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'failed_runs', coalesce((
      select jsonb_agg(jsonb_build_object('job', j.jobname, 'count', r.n, 'last', r.last, 'message', r.msg))
      from (
        select d.jobid, count(*) as n, max(d.end_time) as last, left(max(d.return_message), 200) as msg
        from cron.job_run_details d
        where d.status = 'failed' and d.start_time > now() - p_since
        group by d.jobid
      ) r
      join cron.job j on j.jobid = r.jobid
      where j.jobname <> 'health-check-hourly'
    ), '[]'::jsonb),
    'failed_calls', coalesce((
      select jsonb_agg(jsonb_build_object('status', c.status_code, 'timed_out', c.timed_out, 'count', c.n, 'last', c.last, 'sample', c.sample))
      from (
        select status_code, timed_out, count(*) as n, max(created) as last,
               left(max(coalesce(content::text, error_msg, '')), 200) as sample
        from net._http_response
        where created > now() - p_since
          and (timed_out or status_code is null or status_code >= 400)
        group by status_code, timed_out
      ) c
    ), '[]'::jsonb)
  );
$$;
revoke all on function public.health_cron_signals(interval) from public, anon, authenticated;
grant execute on function public.health_cron_signals(interval) to service_role;

-- Hourly, at 25 past (clear of the jobs on the hour and every 5/15 minutes).
select cron.schedule(
  'health-check-hourly',
  '25 * * * *',
  $cron$
  select net.http_post(
    url := 'https://wuvqwuviwubthmuncuya.supabase.co/functions/v1/health_check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', coalesce((select secret from public.health_check_cron_secret where id = 'default'), '')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);
