-- Outreach (Emil, 2026-11-02): everything about sending is set on the Outreach
-- page's Settings tab, his own email signature goes under every email (Gmail only
-- adds it to mail written in Gmail, not to mail sent through an app password), and
-- the Overview counts who opened their report after being emailed.

alter table public.outreach_settings
  add column if not exists max_followups integer not null default 1 check (max_followups between 0 and 2),
  add column if not exists followup_gap_days integer not null default 3 check (followup_gap_days between 1 and 14),
  add column if not exists send_start_hour integer not null default 9 check (send_start_hour between 0 and 23),
  add column if not exists send_end_hour integer not null default 16 check (send_end_hour between 1 and 24),
  add column if not exists min_gap_minutes integer not null default 45 check (min_gap_minutes between 5 and 240),
  add column if not exists signature_html text;

alter table public.outreach_prospects
  add column if not exists report_views integer not null default 0,
  add column if not exists last_viewed_at timestamptz;

-- The public report notes a view of an outreach audit, once it has been emailed:
-- views before that are Emil checking it, not the prospect.
create or replace function public.outreach_note_view(p_audit_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.outreach_prospects
  set report_views = report_views + 1, last_viewed_at = now()
  where audit_id = p_audit_id and sent_at is not null;
$$;
revoke all on function public.outreach_note_view(uuid) from public, anon, authenticated;
grant execute on function public.outreach_note_view(uuid) to service_role;
