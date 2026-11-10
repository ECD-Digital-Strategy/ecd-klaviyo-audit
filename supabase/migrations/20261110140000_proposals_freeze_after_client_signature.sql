-- Freeze what the client signs at the FIRST client signature (2026-11-10).
-- client_signed_at is only set once every signer has signed, so between signer 1 and signer 2 (and after signing,
-- through the API) the title, sections, discount and contracts could still change, and the Xero invoice reads the
-- live discount. Line items and the signer roster already lock at the first client signature; this does the same
-- for the rest of what the client agreed to.
--
-- Frozen once a client signature exists: title, content_blocks, discount_type, discount_value, discount_applies_to,
-- discount_label, include_contracts, contract_overrides, contracts_snapshot.
-- Still writable after signing (the app and edge functions write these): status, sent_at, first_viewed_at,
-- valid_until, client_signed_at, countersigned_at, won_at, lost_at, lost_reason, updated_at, cover, sent_by,
-- created_by, audit_id, template_id, client_id, xero_invoice_id, xero_invoice_number, xero_invoiced_at,
-- xero_invoice_error, xero_invoices, invoice_sender_id, welcome_email. The signer roster (recipient*, public_token*)
-- stays guarded by trg_proposals_signers_immutable.
--
-- SECURITY DEFINER so the signature check sees every row whatever the caller's RLS allows; the function only reads.

create or replace function public.proposals_block_signed_content_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.title is distinct from old.title
      or new.content_blocks is distinct from old.content_blocks
      or new.discount_type is distinct from old.discount_type
      or new.discount_value is distinct from old.discount_value
      or new.discount_applies_to is distinct from old.discount_applies_to
      or new.discount_label is distinct from old.discount_label
      or new.include_contracts is distinct from old.include_contracts
      or new.contract_overrides is distinct from old.contract_overrides
      or new.contracts_snapshot is distinct from old.contracts_snapshot)
    and exists (
      select 1 from public.proposal_signatures s
      where s.proposal_id = old.id and s.role = 'client'
    )
  then
    raise exception 'Proposal has client signatures; its content, pricing and contracts are immutable'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_proposals_signed_content_immutable on public.proposals;
create trigger trg_proposals_signed_content_immutable
  before update on public.proposals
  for each row
  execute function public.proposals_block_signed_content_mutation();

-- Documents: the lock keyed off documents.signed_at, which staff can set back to null and then edit what was
-- signed. Key it off the recipient's signature row too (written only by the document_sign edge function).
create or replace function public.documents_block_signed_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.signed_at is not null
     or exists (
       select 1 from public.document_signatures s
       where s.document_id = old.id and s.signer_role = 'recipient'
     )
  then
    if new.content is distinct from old.content
       or new.title is distinct from old.title
       or new.recipient_name is distinct from old.recipient_name
       or new.recipient_email is distinct from old.recipient_email then
      raise exception 'Document has been signed; its content and recipient are immutable'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
