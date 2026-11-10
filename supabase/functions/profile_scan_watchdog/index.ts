/**
 * Scheduled worker: resumes stale Klaviyo profile scans and AI analysis jobs
 * without a browser tab open. Runs every 2 minutes via pg_cron.
 */
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { hasCronSecret, isServiceRoleAuthorization } from "../_shared/auth.ts";
import { isTransientError } from "../_shared/transient-errors.ts";
import { releaseStaleRunWithBudget } from "../_shared/job-claim.ts";
import { attemptCapReached, isRunningClaimStale, PROFILE_SCAN_STALE_MS } from "../_shared/klaviyo-audit-logic.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// Above the 150s edge-runtime wall clock on purpose.
//
// A stale-looking job is reset to "pending" and re-kicked, and at 90s that stole
// jobs from invocations still alive and working: the AI path is not claimed
// atomically, so the reset produced a SECOND runner on the same step, paying for
// the same OpenAI call twice and interleaving writes to partial_state. Past 150s
// the runtime has certainly killed whatever held the row, so a reset can only
// revive something genuinely dead.
const STALE_AFTER_MS = 180_000;
const HIGHLIGHT_REGEN_STALE_AFTER_MS = 4 * 60 * 1000;

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
    ...init,
  });
}

function chainAuditFinalize(auditId: string, mode?: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  fetch(`${SUPABASE_URL}/functions/v1/audit_finalize_analysis`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({ audit_id: auditId, ...(mode ? { mode } : {}) }),
  }).catch(() => {});
}

function chainResumeProfileScan(auditId: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  fetch(`${SUPABASE_URL}/functions/v1/klaviyo_fetch_snapshot`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
    },
    body: JSON.stringify({ stage: "resume_profile_scan", audit_id: auditId }),
  }).catch(() => {});
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ ok: false, error: "Missing Supabase env" }, { status: 500 });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Two ways in, and neither is forgeable.
  //
  // The service role key, for a call from another function or by hand. Or the
  // watchdog's own cron secret, which is how the pg_cron schedule authenticates:
  // it used to send a service_role key read from the vault, that copy went stale
  // when the project's keys were refreshed, and the only thing keeping the
  // schedule alive was a shared check that accepted any UNSIGNED JWT claiming
  // role=service_role. A dedicated secret cannot be invalidated by a key
  // rotation and cannot be guessed, which is why the HubSpot sync and the Xero
  // keepalive already work this way.
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const authorized = isServiceRoleAuthorization(token) ||
    await hasCronSecret(req, "watchdog_cron_secret");
  if (!authorized) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const [{ data: profileJobs, error: profileErr }, { data: aiJobs, error: aiErr }] = await Promise.all([
    sb
      .from("klaviyo_profile_scan_jobs")
      .select("audit_id, status, updated_at, error_message, next_path, resume_attempts")
      .in("status", ["pending", "running", "failed"]),
    sb
      .from("audit_analysis_jobs")
      .select("audit_id, status, updated_at, step_index, partial_state, error_message")
      .in("status", ["pending", "running", "failed"]),
  ]);

  if (profileErr) {
    return json({ ok: false, error: profileErr.message }, { status: 500 });
  }
  if (aiErr && aiErr.code !== "PGRST205") {
    return json({ ok: false, error: aiErr.message }, { status: 500 });
  }

  const now = Date.now();
  let profileReset = 0;
  let profileResumed = 0;
  let aiReset = 0;
  let aiResumed = 0;

  for (const job of profileJobs ?? []) {
    // A live scan heartbeats every 20s, so only a dead one gets this old.
    const stale = isRunningClaimStale(job.updated_at as string | null, now, PROFILE_SCAN_STALE_MS);
    if (!stale) continue;

    // A FAILED scan with a cursor and a transient-looking error is four hours
    // of paging one bad Klaviyo minute away from completion: revive it, with a
    // budget so a genuinely broken account cannot loop. Grill Rescue sat failed
    // for nine hours on a 502 with 2.45M profiles already counted, because
    // failed was terminal and nothing ever looked at it again.
    //
    // NOTE: resume_attempts is shared with the scan's own consecutive-block
    // counter (klaviyo_fetch_snapshot parks a CDN-blocked chunk as pending and
    // increments it; any successful chunk zeroes it). Both readings mean "how
    // many times have we failed to get past this spot", so the budget below
    // stays meaningful either way. Transient statuses now park rather than
    // fail, so this branch mainly rescues legacy failed rows.
    if (job.status === "failed") {
      // Written without a backslash-b on purpose. The previous version carried
      // literal backspace bytes where word boundaries were meant, so the 4xx/5xx
      // could never match and NO status-code failure was ever retried: only the
      // words timeout, bad gateway, temporarily and overloaded worked. Proven by
      // evaluating the old expression against "upstream 502" and getting false.
      //
      // Connection-level failures are in the list too. A dropped TCP connection
      // throws instead of returning a status, so the most transient failure
      // there is went unrescued: a HigherDOSE scan died on "connection reset"
      // and the report claimed a scan was running that had been dead for 16
      // minutes.
      const transient = isTransientError(job.error_message);
      const attempts = Number(job.resume_attempts ?? 0);
      if (!transient || attempts >= 4) continue;
      // No cursor means there is nowhere to resume from, so the scan restarts.
      // Its running totals must go back to zero with it, or the restarted pass
      // would add its counts on top of the abandoned one.
      const restarting = !job.next_path;
      await sb.from("klaviyo_profile_scan_jobs").update({
        status: "pending",
        resume_attempts: attempts + 1,
        ...(restarting
          ? { subscribed: 0, sms_subscribed: 0, active90d: 0, suppressed: 0, total_profiles: 0 }
          : {}),
        updated_at: new Date().toISOString(),
      }).eq("audit_id", job.audit_id);
      chainResumeProfileScan(String(job.audit_id));
      profileResumed += 1;
      continue;
    }

    if (job.status === "running") {
      // Only if it is still that same stale run; a scanner that claimed it
      // (or heartbeated) since our read is left alone.
      const { data: freed } = await sb.from("klaviyo_profile_scan_jobs").update({
        status: "pending",
        updated_at: new Date().toISOString(),
      }).eq("audit_id", job.audit_id)
        .eq("status", "running")
        .lt("updated_at", new Date(now - PROFILE_SCAN_STALE_MS).toISOString())
        .select("audit_id");
      if (!freed?.length) continue;
      profileReset += 1;
    }

    chainResumeProfileScan(String(job.audit_id));
    profileResumed += 1;
  }

  // The attempt budget applies to Klaviyo analyses (audit_type klaviyo or
  // unset); web analyses share this table and keep their own behaviour.
  const aiAuditIds = (aiJobs ?? []).map((j) => String(j.audit_id));
  const klaviyoAuditIds = new Set<string>();
  if (aiAuditIds.length) {
    const { data: auditTypes } = await sb.from("audits").select("id, audit_type").in("id", aiAuditIds);
    for (const a of auditTypes ?? []) {
      if (!a.audit_type || a.audit_type === "klaviyo") klaviyoAuditIds.add(String(a.id));
    }
  }

  for (const job of aiJobs ?? []) {
    const partial = (job.partial_state ?? {}) as Record<string, unknown>;
    const isHighlightRegen = partial.highlightRegen === true;
    const isKlaviyo = klaviyoAuditIds.has(String(job.audit_id));
    // A step that used up its attempts stays failed until a person resumes it.
    if (isKlaviyo && job.status === "failed" && attemptCapReached(partial)) continue;

    // A FAILED analysis whose error is transient should resume itself. The step
    // machine already restarts from step_index, so a resume costs one step, not
    // the whole audit. This is the same treatment profile scans got: an
    // Anthropic image-download timeout paused a Power Planter audit behind a
    // human click for no reason. Budgeted via partial_state so a genuinely
    // broken audit stops instead of looping.
    if (job.status === "failed") {
      const transient = isTransientError(job.error_message);
      const resumes = Number(partial.autoResumes ?? 0);
      if (!transient || resumes >= 3) continue;
      const updatedMs = job.updated_at ? Date.parse(String(job.updated_at)) : 0;
      // Give a just-failed job a moment in case a human is already resuming it.
      if (updatedMs && now - updatedMs < 120_000) continue;
      await sb.from("audit_analysis_jobs").update({
        status: "pending",
        partial_state: { ...partial, autoResumes: resumes + 1 },
        updated_at: new Date().toISOString(),
      }).eq("audit_id", job.audit_id);
      chainAuditFinalize(String(job.audit_id), isHighlightRegen ? "highlight_regen" : undefined);
      aiResumed += 1;
      continue;
    }
    const staleAfterMs = isHighlightRegen ? HIGHLIGHT_REGEN_STALE_AFTER_MS : STALE_AFTER_MS;
    const updatedMs = job.updated_at ? Date.parse(String(job.updated_at)) : 0;
    const stale = !updatedMs || now - updatedMs >= staleAfterMs;
    if (!stale) continue;

    if (job.status === "running" && isKlaviyo) {
      // The dead run counts as a timed-out attempt; past the cap the job is
      // marked failed instead of being re-kicked forever.
      const outcome = await releaseStaleRunWithBudget(
        sb,
        String(job.audit_id),
        job as Record<string, unknown>,
        new Date(now - staleAfterMs).toISOString(),
      );
      if (outcome === "noop") continue;
      aiReset += 1;
      if (outcome === "failed") continue;
    } else if (job.status === "running") {
      await sb.from("audit_analysis_jobs").update({
        status: "pending",
        updated_at: new Date().toISOString(),
      }).eq("audit_id", job.audit_id);
      aiReset += 1;
    }

    chainAuditFinalize(String(job.audit_id), isHighlightRegen ? "highlight_regen" : undefined);
    aiResumed += 1;
  }

  return json({
    ok: true,
    profile: { checked: profileJobs?.length ?? 0, reset: profileReset, resumed: profileResumed },
    ai: { checked: aiJobs?.length ?? 0, reset: aiReset, resumed: aiResumed },
  });
});
