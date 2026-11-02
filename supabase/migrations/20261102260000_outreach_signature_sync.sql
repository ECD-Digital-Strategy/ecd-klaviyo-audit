-- Outreach signature follows Gmail (Emil, 2026-11-02: "I already updated it in my
-- Gmail, can you just fetch it"). outreach_send reads it from his newest email
-- written in Gmail, on demand and once a day; it is no longer edited as HTML here.
alter table public.outreach_settings
  add column if not exists signature_synced_at timestamptz;
