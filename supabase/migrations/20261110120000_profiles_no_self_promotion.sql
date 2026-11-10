-- Audit 2026-11-10 (CRITICAL): any signed-in user could make themselves admin.
-- "Users can update own profile" had no column limits, and "Admins can insert
-- profiles" let anyone insert their own row with any role. Checked live the same
-- day: only the 5 expected admins exist, so it was never used.
--
-- After this:
--  - a person can still create their own profile on first sign-in
--    (AuthContext.tsx), but only as a Member ('auditor') with the default area
--    access and their own sign-in email;
--  - a non-admin can still change their own name and saved signature, but not
--    their role, area access, email or id. Admins (and the server's service role)
--    are unaffected.

drop policy if exists "Admins can insert profiles" on public.profiles;
create policy "Admins can insert profiles" on public.profiles
  for insert to authenticated
  with check (
    public.is_admin()
    or (
      auth.uid() = id
      and role = 'auditor'
      and app_access = '{"audits": true, "documents": true, "proposals": true}'::jsonb
      and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

create or replace function public.profiles_guard_self_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only signed-in users through the API are limited; the service role (edge
  -- functions) and direct SQL are not.
  if coalesce(auth.role(), '') = 'authenticated' and not public.is_admin() then
    if new.id is distinct from old.id
      or new.role is distinct from old.role
      or new.app_access is distinct from old.app_access
      or new.email is distinct from old.email then
      raise exception 'Only an admin can change a role, area access or email.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_self_update on public.profiles;
create trigger profiles_guard_self_update
  before update on public.profiles
  for each row execute function public.profiles_guard_self_update();

revoke execute on function public.profiles_guard_self_update() from public, anon, authenticated;
