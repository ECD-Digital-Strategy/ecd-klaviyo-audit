-- Clients come from the ECD CRM (Revenue Desk), not HubSpot (Emil, 2026-11-22: HubSpot is cancelled). The
-- hubspot_sync job is replaced by crm_client_sync, which reads every CRM company through the Hub (crm-outreach action
-- "companies", Hub migration 0374) and creates or links clients the same way. hubspot_cron_secret is reused as its
-- cron secret; hubspot_sync_state keeps the last run for the "Sync now" buttons.
--
-- clients.crm_imported: the row was created by a CRM sync (HubSpot before, Revenue Desk now). Those are CRM companies,
-- most of them never clients, so Outreach no longer reads them as "already a client" (real clients come from the
-- tracker, _shared/outreach-clients.ts). Backfilled from the note hubspot_sync wrote on every row it created.

alter table public.clients add column if not exists crm_imported boolean not null default false;
update public.clients set crm_imported = true where notes = 'Imported from HubSpot' and not crm_imported;

do $$
begin
  perform cron.unschedule('hubspot-sync-every-15min');
exception when others then null;
end $$;

do $$
begin
  perform cron.unschedule('crm-client-sync-every-15min');
exception when others then null;
end $$;

select cron.schedule(
  'crm-client-sync-every-15min',
  '*/15 * * * *',
  $job$
  select net.http_post(
    url := 'https://wuvqwuviwubthmuncuya.supabase.co/functions/v1/crm_client_sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', coalesce((select secret from public.hubspot_cron_secret where id = 'default'), '')
    ),
    body := '{"source":"cron"}'::jsonb,
    timeout_milliseconds := 120000
  );
  $job$
);
