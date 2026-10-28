-- Who can sign for ECD, readable by every staff member (Hugo, 2026-10-28: "doesnt
-- let me change the signature"). The signer list read profiles directly, and
-- profiles lets a Member read only their own row, so a Member saw only
-- themselves in "Sign as", and their new proposals could not default to Zak.
--
-- Rather than open profiles (role and area access stay private), this returns
-- just what signing needs: name, email and the saved signature, for staff
-- (Admins and Members), to staff. The countersign function already lets any
-- staff member sign as a colleague; only the list was missing.
create or replace function public.staff_signers()
returns table (id uuid, name text, email text, signature_image text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.name, p.email, p.signature_image
  from public.profiles p
  where p.role in ('admin', 'auditor')
    and exists (
      select 1 from public.profiles me
      where me.id = auth.uid() and me.role in ('admin', 'auditor')
    )
  order by p.name;
$$;
revoke all on function public.staff_signers() from public, anon;
grant execute on function public.staff_signers() to authenticated;
