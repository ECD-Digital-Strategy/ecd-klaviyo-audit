-- Outreach lead score and auto-pipeline (Emil, 2026-11-02).
-- Each screened store gets a 0-100 lead score from outside signals
-- (_shared/outreach-score.ts); below min_lead_score it is skipped. With
-- auto_pipeline on, outreach_pipeline takes the best new stores, up to
-- auto_audits_per_day: finds the decision-maker, runs the audit and drafts the
-- email, which then waits on the Prospects tab for Emil's approval.
alter table public.outreach_settings
  add column if not exists auto_pipeline boolean not null default false,
  add column if not exists auto_audits_per_day integer not null default 3 check (auto_audits_per_day between 0 and 10),
  add column if not exists min_lead_score integer not null default 40 check (min_lead_score between 0 and 100);

alter table public.outreach_prospects
  add column if not exists lead_score integer,
  -- { tranco_rank, products, currency, country, apps[], reasons[] }
  add column if not exists lead_signals jsonb,
  add column if not exists auto_started_at timestamptz;
create index if not exists outreach_prospects_lead_idx on public.outreach_prospects (status, lead_score desc nulls last);

-- Every 30 minutes; the function does nothing while auto_pipeline is off.
-- (Applied after outreach_pipeline was deployed.)
select cron.schedule(
  'outreach-pipeline',
  '7,37 * * * *',
  $cron$
  select net.http_post(
    url := 'https://wuvqwuviwubthmuncuya.supabase.co/functions/v1/outreach_pipeline',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', coalesce((select secret from public.outreach_cron_secret where id = 'default'), '')
    ),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 150000
  );
  $cron$
);
