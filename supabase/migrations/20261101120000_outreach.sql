-- Outreach (Emil, 2026-11-01): cold outreach to Shopify brands ($1M+) with a free,
-- outside-only web audit. Step 1 is a test batch with Emil in the loop: he pastes
-- store domains, anyone already in HubSpot (or already a client) is skipped, the
-- rest get a web audit from the public site alone, and a short email is drafted for
-- him to approve and send from emil@ecdigitalstrategy.com.

-- Prospects need a client row and an audit like any web audit, flagged so the
-- usual client and audit lists, search and the dashboard leave them out.
alter table public.clients add column if not exists is_outreach boolean not null default false;
alter table public.audits add column if not exists is_outreach boolean not null default false;

create table if not exists public.outreach_prospects (
  id uuid primary key default gen_random_uuid(),
  -- Bare host, lowercase, no www: one row per store, ever.
  domain text not null unique,
  store_name text,
  contact_name text,
  contact_email text,
  status text not null default 'new'
    check (status in ('new', 'skipped', 'auditing', 'ready', 'sent', 'replied', 'unsubscribed', 'failed')),
  skip_reason text,
  client_id uuid references public.clients (id) on delete set null,
  audit_id uuid references public.audits (id) on delete set null,
  email_subject text,
  email_body text,
  notes text,
  sent_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists outreach_prospects_status_idx on public.outreach_prospects (status, created_at desc);

alter table public.outreach_prospects enable row level security;
-- Admins only for now: this is Emil's pipeline, and it holds people's emails.
drop policy if exists "Admins manage outreach prospects" on public.outreach_prospects;
create policy "Admins manage outreach prospects" on public.outreach_prospects
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.outreach_prospects_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists outreach_prospects_touch on public.outreach_prospects;
create trigger outreach_prospects_touch before update on public.outreach_prospects
  for each row execute function public.outreach_prospects_touch();
