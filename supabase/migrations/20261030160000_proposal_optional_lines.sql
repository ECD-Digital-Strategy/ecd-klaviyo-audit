-- Optional lines (2026-10-30, Emil). A line can be marked optional while the proposal is drafted; the client
-- ticks the optional lines they want on the proposal page and the choice is saved when they sign (the first client
-- signer decides; a second signer sees it). Totals, the signed record, the Xero invoice, the Client Tracker hand-off
-- (Hermes) and the feeds to ECD Hub count only what the client took. Until then an optional line looked bought:
-- Lija Style's "Optional: AfterShip Returns Setup" was planned as 8 hours of work.

alter table public.proposal_line_items add column if not exists optional boolean not null default false;
alter table public.proposal_line_items add column if not exists client_selected boolean;
comment on column public.proposal_line_items.optional is
  'The client chooses whether to add this line when signing. Not counted in totals until chosen.';
comment on column public.proposal_line_items.client_selected is
  'Optional lines only: true = the client added it when signing, false = declined, null = not decided yet.';

-- Signed proposals' line items stay immutable, except the Xero coding (2026-10-19) and, once, the client's choice on
-- an optional line (null to true or false), which proposal_sign writes right after the first client signature.
create or replace function public.proposal_line_items_block_signed_mutation()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  target_proposal_id uuid;
  is_locked boolean;
begin
  target_proposal_id := coalesce(new.proposal_id, old.proposal_id);
  select (p.client_signed_at is not null)
      or exists (
        select 1 from public.proposal_signatures s
        where s.proposal_id = p.id and s.role = 'client'
      )
    into is_locked
  from public.proposals p
  where p.id = target_proposal_id;
  if is_locked then
    if tg_op = 'UPDATE'
      and (to_jsonb(new) - 'xero_service_key' - 'xero_item_one_time' - 'xero_item_monthly' - 'updated_at' - 'client_selected')
        = (to_jsonb(old) - 'xero_service_key' - 'xero_item_one_time' - 'xero_item_monthly' - 'updated_at' - 'client_selected')
      and (new.client_selected is not distinct from old.client_selected
           or (old.optional and old.client_selected is null and new.client_selected is not null)) then
      return new;
    end if;
    raise exception 'Proposal has been signed; line items are immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

-- Zak's CRM feed (ECD Hub, every 10 minutes): each fee line says whether it is optional and what the client chose,
-- and a declined optional line is left out, so ECD Hub's copy (sales.proposal_fee_lines) drops it. Live definition
-- as of 2026-10-30 with only the fee_lines block changed.
CREATE OR REPLACE FUNCTION public.crm_proposal_feed(p_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_key is null
     or encode(sha256(convert_to(p_key, 'UTF8')), 'hex')
        <> '5e292481aa9f258585fe2292c57888874c090849d8122b90cf4e30fb4f507e3c' then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'proposals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'proposal_number', p.proposal_number,
        'title', p.title,
        'status', p.status,
        'client_id', p.client_id,
        'created_at', p.created_at,
        'sent_at', p.sent_at,
        'first_viewed_at', p.first_viewed_at,
        'last_client_view_at', v.last_at,
        'client_view_count', coalesce(v.n, 0),
        'client_signed_at', p.client_signed_at,
        'won_at', p.won_at,
        'lost_at', p.lost_at,
        'lost_reason', p.lost_reason,
        'valid_until', p.valid_until,
        'updated_at', p.updated_at
      ) order by p.created_at)
      from proposals p
      left join lateral (
        select max(e.created_at) as last_at, count(*) as n
        from proposal_events e
        where e.proposal_id = p.id and e.event_type = 'viewed' and e.actor = 'client'
      ) v on true
    ), '[]'::jsonb),
    'clients', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'company_name', c.company_name,
        'website_url', c.website_url,
        'hubspot_company_id', c.hubspot_company_id
      ) order by c.created_at)
      from clients c
    ), '[]'::jsonb),
    'fee_lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', li.id,
        'proposal_id', li.proposal_id,
        'display_order', li.display_order,
        'created_at', li.created_at,
        'name', li.name,
        'description', li.description,
        'template_slug', li.template_slug,
        'xero_service_key', li.xero_service_key,
        'one_time_price', li.one_time_price,
        'one_time_label', li.one_time_label,
        'monthly_price', li.monthly_price,
        'monthly_label', li.monthly_label,
        'xero_item_one_time', li.xero_item_one_time,
        'xero_item_monthly', li.xero_item_monthly,
        'optional', li.optional,
        'client_selected', li.client_selected
      ) order by li.proposal_id, li.display_order, li.created_at)
      from proposal_line_items li
      -- An optional line the client did not take when signing was never sold.
      where not (li.optional and li.client_selected is false)
    ), '[]'::jsonb),
    'money', coalesce((
      select jsonb_agg(jsonb_build_object(
        'proposal_id', p.id,
        'discount_type', p.discount_type,
        'discount_value', p.discount_value,
        'discount_applies_to', p.discount_applies_to,
        'discount_label', p.discount_label,
        'countersigned_at', p.countersigned_at,
        'xero_invoiced_at', p.xero_invoiced_at,
        'xero_invoice_number', p.xero_invoice_number,
        'xero_invoices', coalesce((
          select jsonb_agg(jsonb_build_object(
            'kind', i->>'kind', 'id', i->>'id', 'number', i->>'number', 'status', i->>'status',
            'date', i->>'date', 'due_date', i->>'due_date', 'total', i->'total'
          ) order by o)
          from jsonb_array_elements(case when jsonb_typeof(p.xero_invoices) = 'array' then p.xero_invoices else '[]'::jsonb end)
               with ordinality as x(i, o)
        ), '[]'::jsonb),
        'signed_totals', s.totals,
        'signed_totals_at', s.at,
        'payment_terms', coalesce((
          select jsonb_agg(jsonb_build_object('title', b->>'title', 'content', b->>'content') order by o)
          from jsonb_array_elements(case when jsonb_typeof(p.content_blocks) = 'array' then p.content_blocks else '[]'::jsonb end)
               with ordinality as e(b, o)
          where coalesce(b->>'title', '') ~* '(payment|fee|billing|invoic|pricing|\mterms\M|timeline)'
        ), '[]'::jsonb)
      ) order by p.created_at)
      from proposals p
      -- The totals proposal_sign recomputed server-side and froze into the client's signing event.
      left join lateral (
        select e.metadata->'totals' as totals, e.created_at as at
        from proposal_events e
        where e.proposal_id = p.id and e.event_type = 'signed' and e.actor = 'client'
          and jsonb_typeof(e.metadata->'totals') = 'object'
        order by e.created_at desc
        limit 1
      ) s on true
    ), '[]'::jsonb)
  );
end;
$function$
;

-- Athena's read (hub_proposals): line items say whether they are optional and what the client chose. Live definition
-- as of 2026-10-30 with only the line_items block changed.
CREATE OR REPLACE FUNCTION public.hub_proposals(p_key text, p_hubspot_ids text[] DEFAULT NULL::text[], p_domains text[] DEFAULT NULL::text[], p_name text DEFAULT NULL::text, p_proposal_id uuid DEFAULT NULL::uuid, p_proposal_number integer DEFAULT NULL::integer, p_statuses text[] DEFAULT NULL::text[], p_include_contracts boolean DEFAULT false, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_any_filter boolean;
  v_result jsonb;
begin
  if p_key is null
     or encode(sha256(convert_to(p_key, 'UTF8')), 'hex')
        <> 'a172adab83af3760f6e8b49a9f9ed15b3412808798f6e59e37f8ffed04d5b122' then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  v_any_filter := p_proposal_id is not null
    or p_proposal_number is not null
    or coalesce(array_length(p_hubspot_ids, 1), 0) > 0
    or coalesce(array_length(p_domains, 1), 0) > 0
    or v_name is not null;

  with matched as (
    select p.*, c.name as c_name, c.company_name as c_company, c.website_url as c_site,
           c.hubspot_company_id as c_hubspot, c.email as c_email
    from proposals p
    join clients c on c.id = p.client_id
    where (p_statuses is null or p.status = any(p_statuses))
      and (
        not v_any_filter
        or (p_proposal_id is not null and p.id = p_proposal_id)
        or (p_proposal_number is not null and p.proposal_number = p_proposal_number)
        or (c.hubspot_company_id is not null and c.hubspot_company_id = any(p_hubspot_ids))
        or (
          coalesce(c.website_url, '') <> ''
          and lower(regexp_replace(regexp_replace(btrim(c.website_url), '^[a-z]+://(www\.)?', '', 'i'), '[/?#].*$', ''))
              = any(p_domains)
        )
        or (v_name is not null and (c.company_name ilike '%' || v_name || '%' or c.name ilike '%' || v_name || '%'))
      )
    order by p.created_at desc
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', m.id,
      'number', m.proposal_number,
      'title', m.title,
      'status', m.status,
      'client', jsonb_build_object(
        'id', m.client_id, 'name', m.c_name, 'company', m.c_company,
        'website', m.c_site, 'hubspot_company_id', m.c_hubspot, 'email', m.c_email
      ),
      'recipients', jsonb_strip_nulls(jsonb_build_array(
        jsonb_build_object('name', m.recipient_name, 'email', m.recipient_email, 'token', m.public_token),
        case when m.recipient2_email is not null or m.recipient2_name is not null then
          jsonb_build_object('name', m.recipient2_name, 'email', m.recipient2_email, 'token', m.public_token2)
        end
      )),
      'valid_until', m.valid_until,
      'created_at', m.created_at,
      'updated_at', m.updated_at,
      'sent_at', m.sent_at,
      'first_viewed_at', m.first_viewed_at,
      'client_signed_at', m.client_signed_at,
      'countersigned_at', m.countersigned_at,
      'won_at', m.won_at,
      'lost_at', m.lost_at,
      'lost_reason', m.lost_reason,
      'created_by', (select pr.name from profiles pr where pr.id = m.created_by),
      'sent_by', (select pr.name from profiles pr where pr.id = m.sent_by),
      'audit_id', m.audit_id,
      'discount', case when m.discount_type is not null and coalesce(m.discount_value, 0) <> 0 then
        jsonb_build_object('type', m.discount_type, 'value', m.discount_value,
                           'applies_to', m.discount_applies_to, 'label', m.discount_label)
      end,
      'contracts_included', m.include_contracts,
      'contract_overrides', m.contract_overrides,
      'xero', jsonb_strip_nulls(jsonb_build_object(
        'invoice_number', m.xero_invoice_number, 'invoiced_at', m.xero_invoiced_at, 'error', m.xero_invoice_error,
        'invoices', case when jsonb_array_length(coalesce(m.xero_invoices, '[]'::jsonb)) > 0 then (
          select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
            'kind', case i->>'kind' when 'one_time' then 'implementation' when 'monthly' then 'retainer first month' else i->>'kind' end,
            'number', i->>'number',
            'status', coalesce(i->>'status', 'DRAFT'),
            'date', i->>'date',
            'due_date', i->>'due_date',
            'total', (i->>'total')::numeric,
            'payment_link', i->>'online_url'
          )) order by o)
          from jsonb_array_elements(m.xero_invoices) with ordinality as x(i, o)
        ) end
      )),
      'sections', coalesce((
        select jsonb_agg(jsonb_build_object('title', b->>'title', 'content', b->>'content') order by o)
        from jsonb_array_elements(case when jsonb_typeof(m.content_blocks) = 'array' then m.content_blocks else '[]'::jsonb end)
             with ordinality as e(b, o)
      ), '[]'::jsonb),
      'line_items', coalesce((
        select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'name', li.name, 'description', li.description, 'content', li.content,
          'one_time_price', li.one_time_price, 'one_time_label', li.one_time_label,
          'monthly_price', li.monthly_price, 'monthly_label', li.monthly_label,
          'optional', case when li.optional then true end, 'client_selected', li.client_selected
        )) order by li.display_order, li.created_at)
        from proposal_line_items li where li.proposal_id = m.id
      ), '[]'::jsonb),
      'signatures', coalesce((
        select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'role', s.role, 'signer_index', s.signer_index, 'name', coalesce(s.typed_name, s.signer_name),
          'email', s.signer_email, 'signed_at', s.signed_at
        )) order by s.signed_at)
        from proposal_signatures s where s.proposal_id = m.id
      ), '[]'::jsonb),
      'contracts', case when p_include_contracts then coalesce((
        select jsonb_agg(jsonb_build_object('slug', e->>'slug', 'name', e->>'name', 'content', e->>'content'))
        from jsonb_array_elements(case when jsonb_typeof(m.contracts_snapshot) = 'array' then m.contracts_snapshot else '[]'::jsonb end) e
      ), '[]'::jsonb) end
    ) order by m.created_at desc
  ), '[]'::jsonb)
  into v_result
  from matched m;

  return v_result;
end;
$function$
;
