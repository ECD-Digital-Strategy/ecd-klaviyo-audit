-- Outreach follows up event and webinar guests (Emil, 2026-11-11; Zak on the 2026-11-06 call: they already know ECD and
-- came to learn, and nobody follows up with them). Guests are imported from the ECD CRM (crm-outreach, event_leads) into
-- the same prospect list as the cold stores, with where they came from and which email they get:
--   approach 'audit'     their free site audit, opened with the event (like the cold email, warmer);
--   approach 'discovery' no audit: "where do you need the most help?" (Zak's A/B against the audit).
-- Shopify brands are split between the two by their domain, so the split is stable; other brands get discovery.

alter table public.outreach_prospects
  add column if not exists source text not null default 'cold',
  add column if not exists event_id text,
  add column if not exists event_name text,
  add column if not exists event_kind text,
  add column if not exists event_date date,
  add column if not exists approach text,
  add column if not exists other_guests jsonb;

do $$ begin
  alter table public.outreach_prospects add constraint outreach_prospects_source_check check (source in ('cold', 'event'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.outreach_prospects add constraint outreach_prospects_approach_check check (approach is null or approach in ('audit', 'discovery'));
exception when duplicate_object then null; end $$;

comment on column public.outreach_prospects.source is 'cold = a store Emil pasted in; event = a guest of an ECD event or webinar, imported from the CRM.';
comment on column public.outreach_prospects.approach is 'Event guests only: audit (free audit, event as the opener) or discovery (no audit, asks where they need help).';
comment on column public.outreach_prospects.other_guests is 'Other people from the same brand at the event: [{name, email, title}]. Only contact_email is ever emailed.';

create index if not exists outreach_prospects_event_idx on public.outreach_prospects (event_id) where event_id is not null;
