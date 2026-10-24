-- hub_proposals (Athena's read of proposals) now reports every Xero invoice for
-- a proposal, not only the first (Emil, 2026-10-24). Since Oct 19 a deal with
-- implementation and a retainer gets two: the implementation (approved, with the
-- client payment link) and the retainer's first month (a draft dated the 1st).
-- The older single fields stay for anything reading them. Only the xero block
-- changed; the rest is 20261019133846_hub_proposals_read.sql as it was.

create or replace function public.hub_proposals(
  p_key text,
  p_hubspot_ids text[] default null,
  p_domains text[] default null,
  p_name text default null,
  p_proposal_id uuid default null,
  p_proposal_number integer default null,
  p_statuses text[] default null,
  p_include_contracts boolean default false,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
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
        -- Every invoice made for the proposal (implementation and the retainer's
        -- first month are separate), with its status and the client payment link.
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
          'monthly_price', li.monthly_price, 'monthly_label', li.monthly_label
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
$$;

revoke all on function public.hub_proposals(text, text[], text[], text, uuid, integer, text[], boolean, integer) from public;
grant execute on function public.hub_proposals(text, text[], text[], text, uuid, integer, text[], boolean, integer) to anon, authenticated;

comment on function public.hub_proposals(text, text[], text[], text, uuid, integer, text[], boolean, integer) is
  'Read-only proposals for the ECD Hub connector in Athena. Needs the shared key (PROPOSALS_HUB_KEY in Athena); only its SHA-256 is stored here.';
