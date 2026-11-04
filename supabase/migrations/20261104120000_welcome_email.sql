-- The welcome email after signing (Xiomara 2026-11-03, Emil 2026-11-04): the
-- invoice, launch call times, the ECD onboarding form, the W-9 and the client's
-- intake form in one email from the sender's Gmail. Off until switched on in
-- Proposal settings (proposal_settings.invoicing.welcome.enabled).
-- See supabase/functions/_shared/welcome-delivery.ts.

-- Where it is for each proposal: waiting, draft, sent or skipped, and the email itself.
alter table public.proposals add column if not exists welcome_email jsonb;
create index if not exists proposals_welcome_waiting_idx
  on public.proposals ((welcome_email->>'status'))
  where welcome_email is not null;

-- What each person allowed when they connected Google, so the settings page can
-- say when a reconnect adds something (calendar free/busy, 2026-11-04).
alter table public.mailbox_connections add column if not exists scopes text;

-- Every 15 minutes, on the invoice follow-up's own secret. The function does
-- nothing while the welcome email is off.
select cron.unschedule('welcome-email') where exists (select 1 from cron.job where jobname = 'welcome-email');
select cron.schedule('welcome-email', '*/15 * * * *', $cron$
  select net.http_post(
    url := 'https://wuvqwuviwubthmuncuya.supabase.co/functions/v1/invoice_followup',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-secret', coalesce((select secret from public.invoice_cron_secret where id = 'default'), '')),
    body := '{"action":"welcome_tick"}'::jsonb, timeout_milliseconds := 120000);
$cron$);
