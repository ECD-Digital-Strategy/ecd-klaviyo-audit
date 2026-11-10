-- Web pipeline stall nudge, take two (2026-11-10).
--
-- 1. No more double capture chains. Phase 1 used to fire as soon as ANY pending
--    snapshot row was more than 4 minutes old. A healthy run captures its 8 rows
--    one after another, so the last rows routinely waited longer than that, and
--    the nudge started a second chain alongside the live one. It now fires only
--    when the audit's MOST RECENT fetched_at (across all its rows) is older than
--    5 minutes: web_capture_screenshots stamps fetched_at when it claims a row,
--    so a live chain always has a fresh one. Rows are also claimed atomically
--    now, so even an overlapping chain can no longer pick a row someone holds.
--
-- 2. Server-side recovery for the analysis chain. web_finalize_analysis chains
--    itself one step per invocation; if a hop died, only an open browser tab
--    re-kicked it, and outreach audits have no tab. Phase 3 re-kicks a web job
--    that is pending, or running with no heartbeat, for more than 5 minutes,
--    with no screenshots still pending. Each kick is counted in
--    partial_state.nudge_kicks and stops at 3. A re-kick cannot double-run a
--    live step: the function treats "running" as live for 160 seconds and takes
--    a step only through an atomic claim (_shared/job-claim.ts).
--
-- Phase 2 (after-images) is unchanged. While after-images are off it is
-- effectively unreachable: web_finalize_analysis sets web_afters_ready = true
-- the moment analysis ends, which takes the audit out of this phase. The only
-- window left is an analysis still in progress, where web_generate_after
-- refuses to run anyway.

create or replace function public.nudge_stalled_web_pipeline()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_secret text;
  v_row record;
  v_count int := 0;
begin
  -- Authenticate with this job's own secret, not a Supabase key. The vault copy
  -- of the service_role key does not match the project's current key, so both
  -- calls below were coming back "Invalid or expired session": stall recovery
  -- was silently dead. A dedicated secret cannot be invalidated by a rotation.
  select secret into v_secret from public.web_pipeline_cron_secret where id = 'default' limit 1;
  if v_secret is null or v_secret = '' then
    raise warning 'nudge_stalled_web_pipeline: no secret in web_pipeline_cron_secret';
    return 0;
  end if;

  -- PHASE 1: captures. Pending rows remain, and nothing has touched ANY of the
  -- audit's rows for 5 minutes, so no chain is alive.
  for v_row in
    select a.id as audit_id, a.client_id
    from audits a
    join web_page_snapshots s on s.audit_id = a.id
    where a.audit_type = 'web'
      and a.created_at > now() - interval '24 hours'
      and a.client_id is not null
    group by a.id, a.client_id, a.created_at
    having count(*) filter (where s.status = 'pending') > 0
       and coalesce(max(s.fetched_at), a.created_at) < now() - interval '5 minutes'
    order by a.created_at desc
    limit 3
  loop
    perform net.http_post(
      url := 'https://wuvqwuviwubthmuncuya.supabase.co/functions/v1/web_capture_screenshots',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', v_secret
      ),
      body := jsonb_build_object(
        'action', 'run',
        'audit_id', v_row.audit_id,
        'client_id', v_row.client_id
      ),
      -- Past the edge function's 150 s limit, so the logged answer is the function's own.
      timeout_milliseconds := 160000
    );
    v_count := v_count + 1;
  end loop;

  -- PHASE 2: after-images (unreachable while after-images are off, see above).
  for v_row in
    with page_sections as (
      select
        s.audit_id,
        count(*) filter (
          where jsonb_array_length(coalesce(s.section_details->'web'->'findings', '[]'::jsonb)) > 0
        ) as sections_with_findings,
        max(greatest(
          coalesce((s.section_details->'web'->'after_images'->'desktop'->>'generated_at')::timestamptz, 'epoch'::timestamptz),
          coalesce((s.section_details->'web'->'after_images'->'mobile'->>'generated_at')::timestamptz, 'epoch'::timestamptz)
        )) as last_after_at
      from audit_sections s
      where s.section_key in ('web_homepage', 'web_product_page', 'web_collection_page', 'web_cart')
      group by s.audit_id
    )
    select a.id as audit_id
    from audits a
    join page_sections ps on ps.audit_id = a.id
    where a.audit_type = 'web'
      and coalesce(a.web_afters_ready, false) = false
      and a.created_at > now() - interval '24 hours'
      and ps.sections_with_findings >= 2
      and ps.last_after_at < now() - interval '5 minutes'
      and (ps.last_after_at > 'epoch'::timestamptz or a.created_at < now() - interval '10 minutes')
    order by a.created_at desc
    limit 3
  loop
    perform net.http_post(
      url := 'https://wuvqwuviwubthmuncuya.supabase.co/functions/v1/web_generate_after',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', v_secret
      ),
      body := jsonb_build_object('audit_id', v_row.audit_id, 'mode', 'auto'),
      timeout_milliseconds := 160000
    );
    v_count := v_count + 1;
  end loop;

  -- PHASE 3: the analysis chain. A web job left pending, or running with no
  -- heartbeat, for 5 minutes after capture finished is a dead chain. The body
  -- is the same one the chain sends itself ({ audit_id }, no mode), so the
  -- function resumes at the job's step_index.
  for v_row in
    select k.audit_id, k.kicks
    from (
      select j.audit_id, j.updated_at,
        case when (j.partial_state->>'nudge_kicks') ~ '^[0-9]+$'
          then (j.partial_state->>'nudge_kicks')::int else 0 end as kicks
      from audit_analysis_jobs j
      join audits a on a.id = j.audit_id
      where a.audit_type = 'web'
        and j.status in ('pending', 'running')
        and j.updated_at < now() - interval '5 minutes'
        and j.updated_at > now() - interval '24 hours'
        and not exists (
          select 1 from web_page_snapshots s
          where s.audit_id = j.audit_id and s.status = 'pending'
        )
    ) k
    where k.kicks < 3
    order by k.updated_at asc
    limit 3
  loop
    update audit_analysis_jobs
    set partial_state = coalesce(partial_state, '{}'::jsonb) || jsonb_build_object('nudge_kicks', v_row.kicks + 1)
    where audit_id = v_row.audit_id;
    perform net.http_post(
      url := 'https://wuvqwuviwubthmuncuya.supabase.co/functions/v1/web_finalize_analysis',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', v_secret
      ),
      body := jsonb_build_object('audit_id', v_row.audit_id),
      timeout_milliseconds := 160000
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$function$;

revoke all on function public.nudge_stalled_web_pipeline() from public, anon, authenticated;
