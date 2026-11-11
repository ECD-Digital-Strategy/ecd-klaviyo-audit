-- Outreach logs to the ECD CRM instead of HubSpot (Emil, 2026-11-11; Zak asked on the 2026-11-06 call).
-- Screening and the send-time check ask the Hub function crm-outreach (_shared/outreach-crm.ts), and emailed
-- prospects become CRM contacts. The hubspot_* columns stay as history for prospects logged before today.

alter table public.outreach_prospects
  add column if not exists crm_contact_id text,
  add column if not exists crm_company_id text,
  add column if not exists crm_error text;

comment on column public.outreach_prospects.crm_contact_id is 'CRM contact Outreach created for this prospect (sales.contacts.hubspot_contact_id). Null when the person was already in the CRM.';
comment on column public.outreach_prospects.crm_company_id is 'CRM company Outreach created (sales.hubspot_companies.hubspot_id). Null when it was already there.';
comment on column public.outreach_prospects.crm_error is 'Last failure logging this prospect in the CRM; cleared on the next success.';

alter table public.outreach_settings
  add column if not exists crm_log boolean not null default true;

-- Carry the old switch over, so a HubSpot log that was turned off stays off in the CRM.
update public.outreach_settings set crm_log = coalesce(hubspot_log, true) where id = 'default';
