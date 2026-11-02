-- Outreach, step 2 (Emil, 2026-11-02): send as Emil through Gmail. The mailbox and
-- its app password are connected on the Outreach page and stored encrypted in
-- app_secrets (key outreach_mailbox). The guardrails agreed with Emil: at most
-- 3 new emails per weekday in US working hours, at most 2 short follow-ups
-- threaded under the first, stop the moment
-- they reply, and pause everything (and tell Emil) the moment anything bounces.

alter table public.outreach_prospects drop constraint if exists outreach_prospects_status_check;
alter table public.outreach_prospects add constraint outreach_prospects_status_check
  check (status in ('new', 'skipped', 'auditing', 'ready', 'approved', 'sent', 'replied', 'bounced', 'unsubscribed', 'failed'));

alter table public.outreach_prospects
  add column if not exists approved_at timestamptz,
  add column if not exists message_id text,
  add column if not exists followups_sent integer not null default 0,
  add column if not exists last_sent_at timestamptz,
  add column if not exists replied_at timestamptz;

-- Every email sent, first and follow-ups.
create table if not exists public.outreach_sends (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references public.outreach_prospects (id) on delete cascade,
  kind text not null check (kind in ('initial', 'followup_1', 'followup_2')),
  to_email text not null,
  subject text not null,
  message_id text,
  status text not null check (status in ('sent', 'failed')),
  error text,
  sent_at timestamptz not null default now()
);
create index if not exists outreach_sends_sent_at_idx on public.outreach_sends (sent_at desc);
alter table public.outreach_sends enable row level security;
drop policy if exists "Emil reads outreach sends" on public.outreach_sends;
create policy "Emil reads outreach sends" on public.outreach_sends
  for select to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email', '')) = 'emil@ecdigitalstrategy.com');

-- One row of settings.
create table if not exists public.outreach_settings (
  id text primary key default 'default' check (id = 'default'),
  paused boolean not null default false,
  pause_reason text,
  daily_new_cap integer not null default 3 check (daily_new_cap between 0 and 10),
  booking_url text,
  postal_address text,
  updated_at timestamptz not null default now()
);
insert into public.outreach_settings (id) values ('default') on conflict do nothing;
alter table public.outreach_settings enable row level security;
drop policy if exists "Emil manages outreach settings" on public.outreach_settings;
create policy "Emil manages outreach settings" on public.outreach_settings
  for all to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email', '')) = 'emil@ecdigitalstrategy.com')
  with check (lower(coalesce(auth.jwt() ->> 'email', '')) = 'emil@ecdigitalstrategy.com');

-- The autopilot's own secret, like the other cron jobs.
create table if not exists public.outreach_cron_secret (
  id text primary key default 'default',
  secret text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
alter table public.outreach_cron_secret enable row level security;
insert into public.outreach_cron_secret (id) values ('default') on conflict do nothing;

-- Every 20 minutes; the function itself decides whether it is a US weekday in
-- working hours, and does nothing at all until the mailbox is connected.
select cron.schedule(
  'outreach-autopilot',
  '*/20 * * * *',
  $cron$
  select net.http_post(
    url := 'https://wuvqwuviwubthmuncuya.supabase.co/functions/v1/outreach_send',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', coalesce((select secret from public.outreach_cron_secret where id = 'default'), '')
    ),
    body := '{"action":"tick"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cron$
);
