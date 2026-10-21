-- Read-only feed of proposal status for the Revenue Desk CRM in ECD Hub (avvitrgppzroveurlxrl), added 2026-10-20 at
-- Zak's request. ECD Hub calls it every 10 minutes (sales.proposals_pull, ECD Hub migration 0057) to tag deal cards
-- and flag proposals waiting on a signature. Status fields only: no recipient emails, signing links or tokens,
-- prices, sections, contracts or Xero. Gated by its own key, held only in ECD Hub's vault (proposals_feed_key);
-- separate from hub_proposals' key. If you rename a column used here, update this function or the CRM tags go stale.
--
-- Applied to the project directly by Zak's session; this file mirrors it so the repo matches the database.
create or replace function public.crm_proposal_feed(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
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
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.crm_proposal_feed(text) from public;
grant execute on function public.crm_proposal_feed(text) to anon, authenticated, service_role;
comment on function public.crm_proposal_feed(text) is
  'Proposal status for the Revenue Desk CRM (ECD Hub). Key-gated, status fields only. Added 2026-10-20 for Zak.';
