-- Xero coding by Zak's rules (Oct 19, 2026).
--
-- Revenue posts to one of six accounts: three service families, each with an
-- ongoing (MRR) account and a one-time account. Anything on an ongoing invoice
-- goes to 4001/4002/4003; anything billed once (including a single job billed
-- in stages) goes to 4011/4012/4013. The four earlier categories (Klaviyo,
-- SMS, Web/CRO, AI Agents) all fold into these, and 4001 is no longer a
-- shared MRR account: it is Website only.
--
-- Lines also carry a Xero Item (Tier 1 = 1213, Klaviyo Implementation = 1222),
-- one for one-time money and one for monthly. The account still comes from the
-- family, so an Item coded to the wrong account in Xero cannot misfile revenue.

-- 1. The three families.
delete from public.xero_revenue_accounts where service_key not in ('retention', 'website', 'paid_ads');
insert into public.xero_revenue_accounts (service_key, name, one_time_account_code, monthly_account_code, display_order)
values
  ('retention', 'Retention (email, SMS, direct mail)', '4011', '4002', 10),
  ('website', 'Website', '4012', '4001', 20),
  ('paid_ads', 'Paid ads', '4013', '4003', 30)
on conflict (service_key) do update
  set name = excluded.name,
      one_time_account_code = excluded.one_time_account_code,
      monthly_account_code = excluded.monthly_account_code,
      display_order = excluded.display_order;

-- No shared MRR fallback any more: every line's family decides.
update public.xero_connection set mrr_account_code = null where id = 'default';

-- 2. Old categories onto the families.
update public.revenue_opportunity_templates
  set xero_service_key = case when xero_service_key = 'web_cro' then 'website' else 'retention' end
  where xero_service_key in ('klaviyo', 'sms', 'ai_agents', 'web_cro');
-- Signed proposals' lines are immutable (a trigger refuses), so only unsigned
-- ones move; the invoice code reads the old keys for the signed ones.
update public.proposal_line_items li
  set xero_service_key = case when li.xero_service_key = 'web_cro' then 'website' else 'retention' end
  from public.proposals p
  where p.id = li.proposal_id and p.client_signed_at is null
    and li.xero_service_key in ('klaviyo', 'sms', 'ai_agents', 'web_cro');

-- 3. Item columns.
alter table public.revenue_opportunity_templates
  add column if not exists xero_item_one_time text,
  add column if not exists xero_item_monthly text;
alter table public.proposal_line_items
  add column if not exists xero_item_one_time text,
  add column if not exists xero_item_monthly text;

-- Every invoice made for a proposal: one per kind (implementation, first month
-- of the retainer), and later one per scheduled payment.
alter table public.proposals
  add column if not exists xero_invoices jsonb not null default '[]'::jsonb;

-- 4. The catalog, mapped to Zak's Items (duplicates resolved: 1237 Alia Setup,
-- 1231 K: Marketing Analytics; SMS migrations use 1226 K: Migration).
update public.revenue_opportunity_templates t
  set xero_item_one_time = m.one_time, xero_item_monthly = m.monthly, xero_service_key = 'retention'
from (values
  ('ECD Full Implementation', '1222', null),
  ('ECD Mini Implementation', '1223', null),
  ('Klaviyo Marketing Analytics', '1231', null),
  ('Klaviyo Reviews', '1230', null),
  ('Klaviyo Customer Agent', '1126', null),
  ('Klaviyo Helpdesk', '1228', null),
  ('Klaviyo Customer Hub', '1224', null),
  ('Klaviyo SMS', '1235', null),
  ('Direct Mail via PostPilot', '1239', '1212'),
  ('Ongoing Account Management - Tier 1', null, '1213'),
  ('Ongoing Account Management - Tier 2', null, '1214'),
  ('Ongoing Account Management - Tier 3', null, '1215'),
  ('Ongoing Account Management - Tier 4', null, '1216'),
  ('Lifecycle Orchestration Strategy Partnership', null, '1233'),
  ('Flow Growth Retainer', null, '1234'),
  ('Flow Growth Retainer Pro', null, '1234')
) as m(name, one_time, monthly)
where t.name = m.name;

-- Lines on unsigned proposals take their service's Items.
update public.proposal_line_items li
  set xero_item_one_time = coalesce(li.xero_item_one_time, t.xero_item_one_time),
      xero_item_monthly = coalesce(li.xero_item_monthly, t.xero_item_monthly)
from public.revenue_opportunity_templates t, public.proposals p
where li.template_slug = t.slug and p.id = li.proposal_id and p.client_signed_at is null;
