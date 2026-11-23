-- Outreach back to cold website outreach, as a three-email sequence (Emil, 2026-11-23, after research on what gets
-- replies). Webinar and event guests are Zak's now (he follows up in Klaviyo), so Outreach closes them.
--
--   outreach_prospects.followup_1_body  follow-up 1, drafted with the first email: a second finding + the report link
--   outreach_prospects.followup_2_body  follow-up 2: one do-it-yourself fix, no ask, no link
--   outreach_prospects.draft_hooks      which findings (page, viewport, priority, title) the emails used, to learn
--                                       which kinds of finding get replies
--   outreach_settings.followup_2_gap_days  days between follow-up 1 and follow-up 2 (7: replies by about day 10)
-- Two follow-ups by default now (the first email alone gets about half the replies; each follow-up adds something new).

alter table public.outreach_prospects
  add column if not exists followup_1_body text,
  add column if not exists followup_2_body text,
  add column if not exists draft_hooks jsonb;

alter table public.outreach_settings
  add column if not exists followup_2_gap_days integer not null default 7 check (followup_2_gap_days between 1 and 30);

update public.outreach_settings set max_followups = 2 where id = 'default' and max_followups < 2;

-- Event guests never emailed: Zak follows them up in Klaviyo. Kept (not deleted), so a later import skips them.
update public.outreach_prospects
set status = 'skipped', skip_reason = 'Event guest: Zak follows up event guests in Klaviyo', approved_at = null
where source = 'event' and sent_at is null and status not in ('skipped', 'unsubscribed');
