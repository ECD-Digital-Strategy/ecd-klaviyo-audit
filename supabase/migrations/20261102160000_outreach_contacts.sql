-- Outreach decision-maker lookup (Emil, 2026-11-02): who the email goes to, and
-- how sure we are. Filled by outreach_contacts (Hunter); the Hunter key itself is
-- stored encrypted in app_secrets (key outreach_hunter), like the mailbox.
alter table public.outreach_prospects
  add column if not exists contact_title text,
  -- 'hunter' (found at the domain), 'hunter_finder' (a founder named on their site), 'manual'
  add column if not exists contact_source text,
  -- Hunter's verifier: 'valid', 'catch_all' (the domain accepts anything), 'invalid', 'unknown'
  add column if not exists contact_verified text,
  add column if not exists contact_lookup_at timestamptz;
