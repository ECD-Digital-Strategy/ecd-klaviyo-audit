-- Outreach: a teaser report that converts (Emil, 2026-11-02).
-- 1. Opens are counted honestly: at most once per 30 minutes (one visit, not every
--    reload), and never for Emil's own preview link (audit_public skips the call).
-- 2. A hot-lead alert: a prospect who keeps opening their report without replying
--    is worth a call; outreach_send emails Emil once, at hot_lead_views opens.
-- 3. A short, plain note at the end of the teaser on who made it (Emil: no client
--    results, no quotes, nothing salesy). Editable on the Settings tab; empty hides it.

create or replace function public.outreach_note_view(p_audit_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.outreach_prospects
  set report_views = report_views + 1, last_viewed_at = now()
  where audit_id = p_audit_id
    and sent_at is not null
    and (last_viewed_at is null or last_viewed_at < now() - interval '30 minutes');
$$;
revoke all on function public.outreach_note_view(uuid) from public, anon, authenticated;
grant execute on function public.outreach_note_view(uuid) to service_role;

alter table public.outreach_prospects
  add column if not exists hot_alert_at timestamptz;

alter table public.outreach_settings
  -- 0 turns the alert off.
  add column if not exists hot_lead_views integer not null default 3 check (hot_lead_views between 0 and 20),
  add column if not exists about_intro text;
