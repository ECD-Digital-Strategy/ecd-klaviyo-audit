-- Outreach reply handling and HubSpot (Emil, 2026-11-02).
-- The autopilot reads each reply, sorts it (_shared/outreach-replies.ts), emails
-- Emil about the ones worth answering, and puts anyone who says no on a
-- permanent do-not-contact list that screening and sending both check.
-- Emailed prospects are logged in HubSpot (_shared/outreach-hubspot.ts).

create table if not exists public.outreach_suppressions (
  -- Bare host, like outreach_prospects.domain: the whole company is left alone.
  domain text primary key,
  email text,
  reason text not null,
  created_at timestamptz not null default now()
);
alter table public.outreach_suppressions enable row level security;
drop policy if exists "Emil manages outreach suppressions" on public.outreach_suppressions;
create policy "Emil manages outreach suppressions" on public.outreach_suppressions
  for all to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email', '')) = 'emil@ecdigitalstrategy.com')
  with check (lower(coalesce(auth.jwt() ->> 'email', '')) = 'emil@ecdigitalstrategy.com');

alter table public.outreach_prospects
  -- interested, question, referral, not_now, not_interested, unsubscribe, out_of_office, other
  add column if not exists reply_kind text,
  add column if not exists reply_summary text,
  add column if not exists reply_text text,
  -- Messages from them already handled, so each reply is read and sorted once.
  add column if not exists replies_seen integer not null default 0,
  add column if not exists hubspot_contact_id text,
  add column if not exists hubspot_company_id text,
  add column if not exists hubspot_error text;

alter table public.outreach_settings
  add column if not exists hubspot_log boolean not null default true,
  add column if not exists reply_alerts boolean not null default true;
