-- A signed proposal's lines stay immutable, except their Xero coding (Oct 19,
-- 2026). The revenue family and Items say which account the money posts to;
-- they are not part of what the client signed. Most proposals are written
-- freehand, so a line can reach signing uncoded, and the draft invoice then
-- needs someone to code it afterwards (iHome Health Fitness, the first case).

create or replace function public.proposal_line_items_block_signed_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
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
    -- Only the Xero coding changed: allowed.
    if tg_op = 'UPDATE'
      and (to_jsonb(new) - 'xero_service_key' - 'xero_item_one_time' - 'xero_item_monthly' - 'updated_at')
        = (to_jsonb(old) - 'xero_service_key' - 'xero_item_one_time' - 'xero_item_monthly' - 'updated_at') then
      return new;
    end if;
    raise exception 'Proposal has been signed; line items are immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
