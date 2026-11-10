-- Outreach inbox cursor (2026-11-10): each autopilot run reads only the mail that
-- arrived since the last run, instead of two searches per prospect. Stored: the
-- UIDVALIDITY of [Gmail]/All Mail and the last UID fully handled. Null means no
-- cursor yet: the next run scans per prospect once and sets it. Safe to apply
-- before or after the function deploy (without the columns it keeps scanning).
alter table public.outreach_settings
  add column if not exists inbox_uidvalidity bigint,
  add column if not exists inbox_last_uid bigint;
