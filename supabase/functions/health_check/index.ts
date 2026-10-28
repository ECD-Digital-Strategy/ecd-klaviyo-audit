import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { assertServiceRoleClient, hasCronSecret } from "../_shared/auth.ts";
import { keepAliveXero, loadConnection } from "../_shared/xero.ts";
import { sendEmail } from "../_shared/mailer.ts";

// Health check (Emil, 2026-10-28): hourly, by pg_cron (migration
// 20261028120000_health_check.sql). It looks only at things that break silently
// and matter, and emails only when one of them is wrong:
//
//  - Xero can no longer reach the organisation (the October outage went unseen for weeks),
//  - a scheduled job failed, or a call it made came back 401/403/5xx or timed out:
//    what a stale or rotated key looks like,
//  - audit work that is stuck (not finished, untouched for 45 minutes) or failed.
//
// Missing Shopify scopes and the like are left out on purpose: the audit run that
// needs them says so. One problem is emailed at most once a day (health_alert_state)
// and again if it goes away and comes back.

const ALERT_TO = (Deno.env.get("HEALTH_ALERT_TO") ?? "emil@ecdigitalstrategy.com")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const RESEND_AFTER_MS = 23 * 60 * 60 * 1000;
const STUCK = "45 minutes";

type Issue = { key: string; title: string; detail: string };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function checkXero(sb: ReturnType<typeof assertServiceRoleClient>): Promise<Issue[]> {
  // Never connected is not an outage.
  const row = await loadConnection(sb);
  if (!row?.refresh_token_ciphertext) return [];
  const result = await keepAliveXero(sb);
  if (result.ok) return [];
  return [{
    key: "xero",
    title: "Xero has lost its connection",
    detail: `${result.message} Invoices can't be created until Xero is connected again in Proposals > Settings.`,
  }];
}

async function checkScheduledJobs(sb: ReturnType<typeof assertServiceRoleClient>): Promise<Issue[]> {
  const { data, error } = await sb.rpc("health_cron_signals", { p_since: "2 hours" });
  if (error) return [{ key: "health-signals", title: "The health check can't read the scheduled jobs", detail: error.message }];
  const s = (data ?? {}) as {
    failed_runs?: Array<{ job: string; count: number; message: string | null }>;
    failed_calls?: Array<{ status: number | null; timed_out: boolean | null; count: number; sample: string | null }>;
  };
  const issues: Issue[] = [];
  for (const r of s.failed_runs ?? []) {
    issues.push({
      key: `cron-run:${r.job}`,
      title: `Scheduled job "${r.job}" is failing`,
      detail: `${r.count} failed run(s) in the last 2 hours. ${r.message ?? ""}`.trim(),
    });
  }
  for (const c of s.failed_calls ?? []) {
    const what = c.timed_out ? "timed out" : c.status ? `returned ${c.status}` : "got no answer";
    const auth = c.status === 401 || c.status === 403;
    issues.push({
      key: `cron-call:${c.timed_out ? "timeout" : c.status ?? "none"}`,
      title: auth
        ? "A scheduled job is being refused (a key or secret is stale)"
        : `Calls from scheduled jobs ${what}`,
      detail: `${c.count} call(s) ${what} in the last 2 hours. First part of the answer: ${(c.sample ?? "").slice(0, 160)}`,
    });
  }
  return issues;
}

async function checkStuckWork(sb: ReturnType<typeof assertServiceRoleClient>): Promise<Issue[]> {
  const stuckBefore = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const issues: Issue[] = [];

  const [analysisStuck, analysisFailed, scanStuck, scanFailed, captureStuck] = await Promise.all([
    sb.from("audit_analysis_jobs").select("audit_id", { count: "exact", head: true })
      .in("status", ["pending", "running"]).lt("updated_at", stuckBefore).gt("updated_at", dayAgo),
    sb.from("audit_analysis_jobs").select("audit_id, error_message").eq("status", "error").gt("updated_at", dayAgo).limit(3),
    sb.from("klaviyo_profile_scan_jobs").select("audit_id", { count: "exact", head: true })
      .in("status", ["pending", "running"]).lt("updated_at", stuckBefore).gt("updated_at", dayAgo),
    sb.from("klaviyo_profile_scan_jobs").select("audit_id, error_message").eq("status", "failed").gt("updated_at", dayAgo).limit(3),
    sb.from("web_page_snapshots").select("audit_id", { count: "exact", head: true })
      .eq("status", "pending").lt("fetched_at", stuckBefore).gt("fetched_at", dayAgo),
  ]);

  if ((analysisStuck.count ?? 0) > 0) {
    issues.push({ key: "stuck:analysis", title: "An audit's AI analysis is stuck",
      detail: `${analysisStuck.count} analysis job(s) not finished and untouched for over ${STUCK}.` });
  }
  if ((analysisFailed.data ?? []).length > 0) {
    issues.push({ key: "failed:analysis", title: "An audit's AI analysis failed",
      detail: (analysisFailed.data ?? []).map((r) => (r as { error_message: string | null }).error_message ?? "no message").join(" | ").slice(0, 300) });
  }
  if ((scanStuck.count ?? 0) > 0) {
    issues.push({ key: "stuck:profile-scan", title: "A Klaviyo profile scan is stuck",
      detail: `${scanStuck.count} scan(s) not finished and untouched for over ${STUCK}.` });
  }
  if ((scanFailed.data ?? []).length > 0) {
    issues.push({ key: "failed:profile-scan", title: "A Klaviyo profile scan failed",
      detail: (scanFailed.data ?? []).map((r) => (r as { error_message: string | null }).error_message ?? "no message").join(" | ").slice(0, 300) });
  }
  if ((captureStuck.count ?? 0) > 0) {
    issues.push({ key: "stuck:web-capture", title: "Web audit screenshots are stuck",
      detail: `${captureStuck.count} page capture(s) still pending after ${STUCK}.` });
  }
  return issues;
}

serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!(await hasCronSecret(req, "health_check_cron_secret"))) return json({ ok: false, error: "forbidden" }, 403);

  const sb = assertServiceRoleClient();
  const settled = await Promise.allSettled([checkXero(sb), checkScheduledJobs(sb), checkStuckWork(sb)]);
  const issues: Issue[] = settled.flatMap((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : [{ key: `check-error:${i}`, title: "Part of the health check could not run",
           detail: r.reason instanceof Error ? r.reason.message : String(r.reason) }]
  );

  // Forget what is fixed, so it is reported again if it comes back.
  const { data: known } = await sb.from("health_alert_state").select("key, last_sent");
  const keys = new Set(issues.map((i) => i.key));
  const fixed = (known ?? []).map((k) => (k as { key: string }).key).filter((k) => !keys.has(k));
  if (fixed.length) await sb.from("health_alert_state").delete().in("key", fixed);

  const lastSent = new Map((known ?? []).map((k) => [(k as { key: string }).key, (k as { last_sent: string | null }).last_sent]));
  const due = issues.filter((i) => {
    const sent = lastSent.get(i.key);
    return !sent || Date.now() - Date.parse(sent) > RESEND_AFTER_MS;
  });

  if (due.length === 0) return json({ ok: true, issues: issues.length, emailed: 0 });

  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;color:#111">
<p>Something needs a look in the ECD Proposals app:</p>
${due.map((i) => `<p><b>${esc(i.title)}</b><br>${esc(i.detail)}</p>`).join("\n")}
<p style="color:#666;font-size:12px">From the hourly health check. Each problem is emailed at most once a day while it lasts.</p>
</div>`;
  const sent = await sendEmail({
    to: ALERT_TO,
    subject: due.length === 1 ? `ECD health check: ${due[0].title}` : `ECD health check: ${due.length} things need a look`,
    html,
  });
  if (sent.status === "sent") {
    const now = new Date().toISOString();
    await sb.from("health_alert_state").upsert(due.map((i) => ({ key: i.key, title: i.title, last_sent: now })));
  }
  return json({ ok: true, issues: issues.length, emailed: due.length, mail: sent.status });
});
