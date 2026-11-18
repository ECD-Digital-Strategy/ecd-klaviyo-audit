-- Upload a PDF and place signatures on any page (Emil, 2026-11-18: "signatures on pages 47 and 32", like DocuSign).
-- A document is now either kind 'text' (written in the app, one signature block at the end, as before) or kind 'pdf':
-- an uploaded PDF with fields placed on its pages. pdf_fields is a list of
--   { id, page (1-based), x, y, w, h (fractions of the page, from its top-left), type, role }
-- with type 'signature' | 'initials' | 'date' | 'name' and role 'recipient' | 'sender'.
-- One recipient plus optionally us, the same signers as text documents. When the recipient signs, document_sign
-- stamps both signatures into the PDF and adds a signing certificate page (signed_pdf_path), and the sender gets a
-- Gmail draft with it attached to send to the client.

alter table public.documents
  add column if not exists kind text not null default 'text',
  add column if not exists pdf_path text,
  add column if not exists pdf_sha256 text,
  add column if not exists pdf_pages integer,
  add column if not exists pdf_fields jsonb not null default '[]'::jsonb,
  add column if not exists signed_pdf_path text,
  add column if not exists signed_pdf_sha256 text;

do $$ begin
  alter table public.documents add constraint documents_kind_check check (kind in ('text', 'pdf'));
exception when duplicate_object then null; end $$;

-- The recipient's initials, for PDFs with initials fields.
alter table public.document_signatures add column if not exists initials_image text;

-- The PDF and where the fields are cannot change once it has gone out: what the client signs is what was sent.
create or replace function public.documents_pdf_locked_after_send()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if old.status <> 'draft'
     and (new.pdf_path is distinct from old.pdf_path
       or new.pdf_sha256 is distinct from old.pdf_sha256
       or new.pdf_pages is distinct from old.pdf_pages
       or new.pdf_fields is distinct from old.pdf_fields
       or new.kind is distinct from old.kind)
     -- Reopening a voided document back to draft is the one way to change them again.
     and not (new.status = 'draft')
  then
    raise exception 'The PDF and its fields cannot change after the document is sent. Void and reopen it first.' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_documents_pdf_locked_after_send on public.documents;
create trigger trg_documents_pdf_locked_after_send
  before update on public.documents
  for each row execute function public.documents_pdf_locked_after_send();

-- Private storage: originals/<document id>.pdf (uploaded by staff) and signed/<document id>.pdf (made by the server).
-- The public signing page never reads the bucket directly; document_public hands it a short-lived signed link.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('signing-docs', 'signing-docs', false, 26214400, array['application/pdf'])
on conflict (id) do nothing;

drop policy if exists "Staff upload PDFs to sign" on storage.objects;
create policy "Staff upload PDFs to sign" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'signing-docs' and name like 'originals/%'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'auditor'))
    and public.has_app_access('documents')
  );

drop policy if exists "Staff read PDFs to sign" on storage.objects;
create policy "Staff read PDFs to sign" on storage.objects for select to authenticated
  using (
    bucket_id = 'signing-docs'
    and exists (select 1 from public.profiles p where p.id = auth.uid())
    and public.has_app_access('documents')
  );

drop policy if exists "Staff replace draft PDFs" on storage.objects;
create policy "Staff replace draft PDFs" on storage.objects for update to authenticated
  using (
    bucket_id = 'signing-docs' and name like 'originals/%'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('admin', 'auditor'))
    and public.has_app_access('documents')
  );

-- The signed-PDF steps in the activity log, and the initials image kept to the same size as signatures.
alter table public.document_events drop constraint if exists document_events_event_type_check;
alter table public.document_events add constraint document_events_event_type_check
  check (event_type = any (array['created','updated','sent','resent','viewed','signed','void','reopened','signed_pdf','signed_pdf_drafted','signed_pdf_failed']));
alter table public.document_signatures drop constraint if exists document_signatures_initials_image_check;
alter table public.document_signatures add constraint document_signatures_initials_image_check check (initials_image is null or length(initials_image) < 400000);
