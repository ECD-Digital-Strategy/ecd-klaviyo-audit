-- Klaviyo audit pipeline: one owner per profile scan and per reporting run.
--
-- 1. Profile scan. A chunk runs up to ~148s but the claim reclaimed 'running'
--    rows after 90s, so browser nudges started second and third scanners on
--    the same job (likely what tripped Klaviyo's 403 blocks) and their writes
--    overwrote each other. The scan now heartbeats updated_at while it pages,
--    the stale threshold is 180s, and every claim gets a fresh claim_token that
--    each progress write must match, so a stale lineage's writes are rejected.
--    Keep 180s in step with PROFILE_SCAN_STALE_MS in
--    supabase/functions/_shared/klaviyo-audit-logic.ts.
alter table public.klaviyo_profile_scan_jobs
  add column if not exists claim_token uuid;

create or replace function public.claim_profile_scan_job(p_audit_id uuid)
returns setof public.klaviyo_profile_scan_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.klaviyo_profile_scan_jobs j
  set status = 'running', updated_at = now(), claim_token = gen_random_uuid()
  where j.audit_id = p_audit_id
    and (
      j.status = 'pending'
      or (j.status = 'running' and j.updated_at < now() - interval '180 seconds')
    )
  returning j.*;
end;
$$;

revoke execute on function public.claim_profile_scan_job(uuid) from public, anon, authenticated;
grant execute on function public.claim_profile_scan_job(uuid) to service_role;

-- 2. Reporting stage. The browser re-invoked stage 'reporting' after 120s with
--    no log row, while one run takes 90s or more and logs only at the end, so
--    two runs delete+inserted flow_performance together. The run now claims
--    the audit's rollup row (compare-and-set on reporting_started_at), and a
--    second run within 10 minutes exits. The config stage re-seeds the rollup,
--    so a fresh audit run always starts unclaimed.
alter table public.klaviyo_reporting_rollups
  add column if not exists reporting_started_at timestamptz,
  add column if not exists reporting_claim uuid;

-- 3. flow_performance had no key, so doubled runs doubled flows and revenue.
--    Rows now carry the Klaviyo flow id, unique per audit.
alter table public.flow_performance
  add column if not exists flow_id text;

-- Dedupe existing rows first: when the same flow name appears in two insert
-- batches for one audit, keep the newest batch. Rows from one batch share a
-- created_at, so two different flows that happen to share a name survive.
delete from public.flow_performance fp
using public.flow_performance newer
where fp.audit_id = newer.audit_id
  and fp.flow_name = newer.flow_name
  and newer.created_at > fp.created_at;

create unique index if not exists flow_performance_audit_flow_id_key
  on public.flow_performance (audit_id, flow_id)
  where flow_id is not null;
