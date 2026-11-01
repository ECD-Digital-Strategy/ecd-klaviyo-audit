-- The stall nudge waits for the real answer (2026-11-01, Emil). It gave up after 15 seconds, but taking a web
-- audit's screenshots runs 30 to 150 seconds (an edge function's limit), so every nudge was logged as "timed out"
-- while the capture went on and finished, and the hourly health check emailed "Calls from scheduled jobs timed out"
-- about work that was fine. pg_net waits in the background, so a longer wait holds up nothing; at 160 seconds,
-- just past the function's limit, the logged answer is the real one: 200 when it worked, 504 when a capture
-- really ran out of time.
--
-- This also records the live definition: the version that authenticates with web_pipeline_cron_secret was only
-- ever changed on the database, so no earlier migration has it.

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

  -- PHASE 1: captures. A row still pending, whose last attempt is old enough that
  -- no invocation can still be working on it, means the chain died holding it.
  for v_row in
    select a.id as audit_id, a.client_id
    from audits a
    where a.audit_type = 'web'
      and a.created_at > now() - interval '24 hours'
      and a.client_id is not null
      and exists (
        select 1 from web_page_snapshots s
        where s.audit_id = a.id
          and s.status = 'pending'
          and coalesce(s.fetched_at, a.created_at) < now() - interval '4 minutes'
      )
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

  -- PHASE 2: after-images.
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

  return v_count;
end;
$function$;
