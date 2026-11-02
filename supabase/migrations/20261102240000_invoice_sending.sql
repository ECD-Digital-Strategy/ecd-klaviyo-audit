-- Invoices emailed to clients from a person's own Gmail (Emil + Isa, 2026-11-02).
-- Built switched OFF: proposal_settings.invoicing.auto_send and .overdue_nudges
-- both default to false, and until they are turned on everything behaves as before
-- (the payment link goes to the proposal's sender to forward by hand).
--
-- A few people (Xiomara, Isa...) connect their Gmail with Google sign-in
-- (gmail_connect; send-only permission). Each proposal says who its invoice comes
-- from (invoice_sender_id, defaulting to whoever sent the proposal). When the
-- client signs, the implementation invoice goes to the client from that mailbox
-- with the PDF and the pay link, Maria copied. Monthly invoices stay drafts for
-- Maria. Unpaid ones nudge Maria and the sender 7 days past due, then weekly
-- (invoice_followup, daily cron).

create table if not exists public.mailbox_connections (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  refresh_token_ciphertext text not null,
  refresh_token_iv text not null,
  connected_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_error text
);
-- Tokens never leave the server: no policies, so only the service role reads it.
alter table public.mailbox_connections enable row level security;

create table if not exists public.gmail_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  return_to text,
  created_at timestamptz not null default now()
);
alter table public.gmail_oauth_states enable row level security;

/** Who can send invoices: connected mailboxes, for the "Invoice sent by" picker.
 * Names and addresses only. */
create or replace function public.invoice_senders()
returns table (user_id uuid, name text, email text, connected_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.user_id, coalesce(nullif(p.name, ''), m.email), m.email, m.connected_at
  from public.mailbox_connections m
  left join public.profiles p on p.id = m.user_id
  where auth.uid() is not null
  order by 2;
$$;
revoke all on function public.invoice_senders() from public, anon;
grant execute on function public.invoice_senders() to authenticated;

alter table public.proposals
  -- Whose Gmail the invoice is emailed from; null = whoever sent the proposal.
  add column if not exists invoice_sender_id uuid references auth.users (id) on delete set null;

-- The daily follow-up job's own secret, like the other cron jobs.
create table if not exists public.invoice_cron_secret (
  id text primary key default 'default',
  secret text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
);
alter table public.invoice_cron_secret enable row level security;
insert into public.invoice_cron_secret (id) values ('default') on conflict do nothing;

-- The cron (applied after invoice_followup is deployed): every day at 14:00 UTC,
-- 9 or 10 in New York. The function does nothing while overdue_nudges is off.
-- select cron.schedule('invoice-followup', '0 14 * * *', $cron$
--   select net.http_post(
--     url := 'https://wuvqwuviwubthmuncuya.supabase.co/functions/v1/invoice_followup',
--     headers := jsonb_build_object('Content-Type', 'application/json',
--       'x-cron-secret', coalesce((select secret from public.invoice_cron_secret where id = 'default'), '')),
--     body := '{"action":"tick"}'::jsonb, timeout_milliseconds := 120000);
-- $cron$);
