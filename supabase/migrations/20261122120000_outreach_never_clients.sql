-- Outreach never lists or emails an ECD client (Emil, 2026-11-22). A webinar guest from sbblooms.com showed up as
-- "In the CRM (prospect)", but SB Blooms is an active client known as somethingborrowedblooms.com (sbblooms.com
-- redirects there). Brands are now matched against every ECD client (Hub migration 0369) by domain, redirect,
-- subdomain, guest email and name (_shared/outreach-clients.ts), and a sweep in the outreach tick re-checks the
-- whole list every day.
--
--   is_client          an ECD client, past or current: hidden from the list, never audited or emailed again.
--   site_domain        where the brand's website ends up after redirects ('' = read, it goes nowhere else).
--   client_checked_at  when the client check last ran for this brand (the sweep takes the oldest first).

alter table public.outreach_prospects
  add column if not exists is_client boolean not null default false,
  add column if not exists site_domain text,
  add column if not exists client_checked_at timestamptz;

create index if not exists outreach_prospects_client_check_idx
  on public.outreach_prospects (client_checked_at nulls first)
  where not is_client;
