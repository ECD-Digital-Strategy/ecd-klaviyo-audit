-- Outreach is Emil's alone for now (Emil, 2026-11-01). Was: any admin.
drop policy if exists "Admins manage outreach prospects" on public.outreach_prospects;
drop policy if exists "Emil manages outreach prospects" on public.outreach_prospects;
create policy "Emil manages outreach prospects" on public.outreach_prospects
  for all to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email', '')) = 'emil@ecdigitalstrategy.com')
  with check (lower(coalesce(auth.jwt() ->> 'email', '')) = 'emil@ecdigitalstrategy.com');
