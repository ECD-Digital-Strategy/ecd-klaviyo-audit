import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isServiceRoleAuthorization, requireStaffUserId } from "../_shared/auth.ts";
import { persistAuditAnalysisResults } from "../_shared/audit-analysis-persist.ts";
import { autoPublishAudit } from "../_shared/auto-publish.ts";
import { claimJobStep, ensureJobRow, releaseStaleRunWithBudget, writeClaimedStep } from "../_shared/job-claim.ts";
import { attemptsForStep, classifyStepFailure, decideStepFailure } from "../_shared/klaviyo-audit-logic.ts";

/** The AI call is aborted this long after the invocation started, leaving room
 * inside the 150s wall clock to record the attempt and chain a retry. */
const AI_CALL_DEADLINE_MS = 135_000;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const SECTION_BATCHES: string[][] = [
  ["account_health"],
  ["flows"],
  ["segmentation"],
  ["campaigns"],
  ["email_design"],
  ["signup_forms"],
];

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type, accept, origin, referer, user-agent",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
    ...init,
  });
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function assertServiceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function auditContextHasContent(context: unknown): boolean {
  if (!context || typeof context !== "object") return false;
  const c = context as Record<string, unknown>;
  return Boolean(
    String(c.meeting_notes ?? "").trim() ||
      String(c.client_background ?? "").trim() ||
      String(c.custom_instructions ?? "").trim(),
  );
}

type StepKind = "top_level" | "section" | "sections_for_highlight" | "refine" | "persist";

type StepDef = { kind: StepKind; keys?: string[] };

const AUDIT_SECTION_KEYS_ALL = [
  "account_health",
  "flows",
  "segmentation",
  "campaigns",
  "email_design",
  "signup_forms",
];

function buildStepPlan(hasRefine: boolean, highlightRegen = false): StepDef[] {
  if (highlightRegen) {
    return [
      { kind: "top_level" },
      { kind: "sections_for_highlight" },
      { kind: "persist" },
    ];
  }
  const steps: StepDef[] = [{ kind: "top_level" }];
  for (const keys of SECTION_BATCHES) steps.push({ kind: "section", keys });
  if (hasRefine) steps.push({ kind: "refine" });
  steps.push({ kind: "persist" });
  return steps;
}

function extractHighlightedAddOns(layout: unknown) {
  const layoutObj = (layout as Record<string, unknown> | null | undefined) ?? {};
  const revenueSummary = layoutObj.revenue_summary as Record<string, unknown> | undefined;
  const blocks = revenueSummary?.blocks as Record<string, unknown> | undefined;
  const addOns = blocks?.addOns as Record<string, unknown> | undefined;
  const items = Array.isArray(addOns?.items) ? addOns.items : [];
  return items
    .filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).highlighted === true)
    .map((item) => {
      const row = item as Record<string, unknown>;
      return {
        template_slug: String(row.template_slug ?? ""),
        name: String(row.name ?? ""),
        description: row.description ? String(row.description) : undefined,
      };
    })
    .filter((a) => a.template_slug && a.name);
}

async function chainSelf(auditId: string, mode?: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    await Promise.race([
      fetch(`${SUPABASE_URL}/functions/v1/audit_finalize_analysis`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: SUPABASE_SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({ audit_id: auditId, ...(mode ? { mode } : {}) }),
      }),
      sleep(4_000),
    ]);
  } catch {
    // best effort
  }
}

/** Fire the direct mail step and move on. Only the request has to be accepted;
 * the race keeps this invocation from waiting on a model call it does not need. */
async function kickDirectMail(auditId: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    await Promise.race([
      fetch(`${SUPABASE_URL}/functions/v1/klaviyo_direct_mail`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: SUPABASE_SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({ audit_id: auditId }),
      }),
      sleep(2_500),
    ]);
  } catch {
    // best effort; the section can be regenerated on demand
  }
}

/** An AI step failure with the callee's error code, used to decide on a retry. */
class AiStepError extends Error {
  code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.code = code;
  }
}

/** One AI call, aborted at `deadlineAtMs`. Retries no longer happen inside the
 * invocation (three 120s tries could never fit in 150s); a failed attempt is
 * recorded on the job and retried by a fresh invocation. */
async function invokeAiAnalyze(body: Record<string, unknown>, deadlineAtMs: number, label: string) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.max(20_000, deadlineAtMs - Date.now()));
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/ai_analyze_audit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!data?.ok) {
      const msg = data?.error?.message ?? `AI request failed (${res.status})`;
      throw new AiStepError(`${label}: ${msg}`, data?.error?.code ?? null);
    }
    return data;
  } catch (e) {
    if (e instanceof AiStepError) throw e;
    if (ctrl.signal.aborted) throw new AiStepError(`${label}: AI call timed out`, "timeout");
    throw new AiStepError(`${label}: ${e instanceof Error ? e.message : String(e)}`, null);
  } finally {
    clearTimeout(t);
  }
}

async function seedPartialFromAudit(sb: ReturnType<typeof assertServiceClient>, auditId: string) {
  const { data: audit } = await sb.from("audits").select("executive_summary").eq("id", auditId).single();
  let strengths: string[] = [];
  let findings: string[] = [];
  let implementationTimeline: unknown[] = [];
  let executiveSummary = "";
  try {
    const parsed = JSON.parse(String(audit?.executive_summary ?? ""));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      strengths = Array.isArray(parsed.strengths) ? parsed.strengths.map((s: string) => String(s)) : [];
      findings = Array.isArray(parsed.findings) ? parsed.findings.map((s: string) => String(s)) : [];
      implementationTimeline = Array.isArray(parsed.timeline) ? parsed.timeline : [];
      executiveSummary = typeof parsed.text === "string" ? parsed.text : "";
    }
  } catch {
    executiveSummary = String(audit?.executive_summary ?? "");
  }

  const { data: sectionRows } = await sb
    .from("audit_sections")
    .select(
      "section_key, current_state_title, optimized_state_title, current_state_notes, optimized_notes, ai_findings, key_findings, summary_text, revenue_opportunity, confidence, section_details",
    )
    .eq("audit_id", auditId);

  const sections = (sectionRows ?? [])
    .filter((s) => s.section_key && s.section_key !== "revenue_summary")
    .map((s) => ({
      section_key: s.section_key,
      current_state_title: s.current_state_title ?? "",
      optimized_state_title: s.optimized_state_title ?? "",
      current_state_notes: s.current_state_notes ?? "",
      optimized_notes: s.optimized_notes ?? "",
      ai_findings: s.ai_findings ?? "",
      summary_text: s.summary_text ?? "",
      key_findings: s.key_findings ?? { items: [], items_hidden: [] },
      revenue_opportunity: Number(s.revenue_opportunity) || 0,
      confidence: s.confidence ?? "medium",
      section_details: s.section_details ?? {},
    }));

  return {
    executiveSummary,
    findings,
    strengths,
    implementationTimeline,
    sections,
    _preservedStrengths: strengths,
    highlightRegen: true,
  };
}

async function buildWizardData(sb: ReturnType<typeof assertServiceClient>, auditId: string) {
  const { data: audit, error: auditErr } = await sb
    .from("audits")
    .select("id, client_id, list_size, aov, monthly_traffic, context, layout")
    .eq("id", auditId)
    .single();
  if (auditErr || !audit) throw auditErr ?? new Error("Audit not found");

  const { data: client, error: clientErr } = await sb
    .from("clients")
    .select("id, name, company_name, industry, esp_platform, website_url, notes")
    .eq("id", audit.client_id)
    .single();
  if (clientErr || !client) throw clientErr ?? new Error("Client not found");

  const { data: profileJob } = await sb
    .from("klaviyo_profile_scan_jobs")
    .select("status")
    .eq("audit_id", auditId)
    .maybeSingle();

  let profileAudienceScan: "full" | "skipped" | "timed_out" = "full";
  if (!profileJob || profileJob.status === "skipped") profileAudienceScan = "skipped";
  else if (profileJob.status === "complete") profileAudienceScan = "full";

  const context = audit.context ?? undefined;
  return {
    wizard: {
      auditId,
      clientId: client.id,
      clientName: client.name,
      companyName: client.company_name,
      industry: client.industry,
      espPlatform: client.esp_platform || "Klaviyo",
      websiteUrl: client.website_url || "",
      listSize: Math.round(Number(audit.list_size) || 0),
      // audits.aov holds flow revenue per recipient (often under $1), so keep cents.
      aov: Math.round((Number(audit.aov) || 0) * 100) / 100,
      monthlyTraffic: Math.round(Number(audit.monthly_traffic) || 0),
      notes: client.notes || "",
      auditMethod: "api",
      auditContext: context,
      profileAudienceScan,
      clientSellsSubscriptions: Boolean((context as Record<string, unknown> | null)?.sells_subscriptions),
      highlightedAddOns: extractHighlightedAddOns(audit.layout),
    },
    hasRefine: auditContextHasContent(context),
  };
}

async function ensureJob(sb: ReturnType<typeof assertServiceClient>, auditId: string, clientId: string) {
  // deno-lint-ignore no-explicit-any
  return { job: (await ensureJobRow(sb, auditId, clientId, {})) as any };
}

async function runPipeline(
  auditId: string,
  correlationId: string,
  options?: { mode?: string },
): Promise<Response> {
  const sb = assertServiceClient();
  const highlightRegen = options?.mode === "highlight_regen";
  const aiDeadlineAtMs = Date.now() + AI_CALL_DEADLINE_MS;

  const { data: audit, error: auditErr } = await sb
    .from("audits")
    .select("id, client_id, executive_summary, audit_method, audit_type")
    .eq("id", auditId)
    .maybeSingle();
  if (auditErr) throw auditErr;
  if (!audit) return json({ ok: false, error: { code: "not_found", message: "Audit not found" }, correlationId }, { status: 404 });
  if ((audit as { audit_type?: string }).audit_type && (audit as { audit_type?: string }).audit_type !== "klaviyo") {
    return json({ ok: true, correlationId, status: "skipped", reason: "unsupported_audit_type" });
  }
  if (audit.audit_method !== "api") {
    return json({ ok: true, correlationId, status: "skipped", reason: "not_api_audit" });
  }
  if (!highlightRegen && String(audit.executive_summary ?? "").trim()) {
    const { data: activeJob } = await sb
      .from("audit_analysis_jobs")
      .select("status, partial_state")
      .eq("audit_id", auditId)
      .maybeSingle();
    const partial = (activeJob?.partial_state ?? {}) as Record<string, unknown>;
    const highlightJobActive = Boolean(
      partial.highlightRegen
      && activeJob
      && ["pending", "running"].includes(String(activeJob.status)),
    );
    if (!highlightJobActive) {
      // A full run cannot proceed once the summary exists, so a pending or
      // running full-run row here was orphaned by a runner that lost a race.
      // Left alone it was re-kicked by the watchdog every five minutes forever.
      if (activeJob && ["pending", "running"].includes(String(activeJob.status))) {
        await sb.from("audit_analysis_jobs")
          .update({ status: "complete", updated_at: new Date().toISOString() })
          .eq("audit_id", auditId)
          .in("status", ["pending", "running"]);
      }
      return json({ ok: true, correlationId, status: "complete", reason: "already_analyzed" });
    }
  }

  let job;
  if (highlightRegen) {
    if (!String(audit.executive_summary ?? "").trim()) {
      return json({ ok: false, error: { code: "bad_request", message: "Audit has no analysis to regenerate" }, correlationId }, { status: 400 });
    }
    const { data: existingHighlightJob } = await sb
      .from("audit_analysis_jobs")
      .select("*")
      .eq("audit_id", auditId)
      .maybeSingle();
    const existingPartial = (existingHighlightJob?.partial_state ?? {}) as Record<string, unknown>;
    const continuingHighlight = Boolean(
      existingHighlightJob
      && existingPartial.highlightRegen
      && ["pending", "running"].includes(String(existingHighlightJob.status))
      && Number(existingHighlightJob.step_index) > 0
      && Number(existingHighlightJob.step_index) < 999,
    );
    if (continuingHighlight) {
      job = existingHighlightJob!;
    } else {
      const partialState = await seedPartialFromAudit(sb, auditId);
      const { data: upserted, error: upsertErr } = await sb
        .from("audit_analysis_jobs")
        .upsert({
          audit_id: auditId,
          client_id: audit.client_id,
          status: "pending",
          step_index: 0,
          partial_state: partialState,
          error_message: null,
          updated_at: new Date().toISOString(),
        }, { onConflict: "audit_id" })
        .select("*")
        .single();
      if (upsertErr) throw upsertErr;
      job = upserted!;
    }
  } else {
    const { job: initialJob } = await ensureJob(sb, auditId, audit.client_id as string);
    job = initialJob;
  }
  if (job.status === "failed") {
    // Resume where it failed: keep step_index and the work in partial_state,
    // and give the failed step a fresh attempt budget. This used to restart at
    // step 0 with nothing, paying again for every step already done.
    const {
      stepAttempts: _attempts,
      attemptCapReached: _cap,
      ...keptPartial
    } = (job.partial_state ?? {}) as Record<string, unknown>;
    const { data: reset, error: resetErr } = await sb
      .from("audit_analysis_jobs")
      .update({
        status: "pending",
        partial_state: keptPartial,
        error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("audit_id", auditId)
      .eq("status", "failed")
      .select("*")
      .maybeSingle();
    if (resetErr) throw resetErr;
    if (!reset) {
      return json({ ok: true, correlationId, status: "in_progress", reason: "resumed_elsewhere" });
    }
    job = reset;
  }
  if (job.status === "complete" && !highlightRegen) {
    return json({ ok: true, correlationId, status: "complete" });
  }

  // 160s, above the 150s edge-runtime wall clock. At 90s a step that was still
  // legitimately running (one AI call has a 120s timeout, and invokeAiWithRetry
  // may take more than one) was declared dead, and since nothing claims this job
  // atomically the result was two runners on the same step: the same OpenAI call
  // billed twice, both writing partial_state. Past the wall clock the invocation
  // is certainly gone, so "running and older than this" really does mean dead.
  const jobUpdatedMs = job.updated_at ? Date.parse(String(job.updated_at)) : 0;
  const jobStale = job.status === "running" && jobUpdatedMs > 0 && Date.now() - jobUpdatedMs >= 160_000;
  if (job.status === "running" && !jobStale) {
    return json({ ok: true, correlationId, status: "in_progress", reason: "already_running" });
  }
  if (jobStale) {
    // The dead run counts as a timed-out attempt at its step, so a step that
    // keeps dying on the wall clock stops after the cap instead of looping.
    const released = await releaseStaleRunWithBudget(sb, auditId, job, new Date(Date.now() - 160_000).toISOString());
    if (released === "failed") {
      return json({ ok: false, correlationId, status: "failed", error: "step attempts exhausted" }, { status: 200 });
    }
    const { data: fresh, error: freshErr } = await sb.from("audit_analysis_jobs").select("*").eq("audit_id", auditId).maybeSingle();
    if (freshErr) throw freshErr;
    if (!fresh || fresh.status !== "pending") {
      return json({ ok: true, correlationId, status: "in_progress", reason: "already_running" });
    }
    job = fresh;
  }

  const { wizard, hasRefine } = await buildWizardData(sb, auditId);
  const steps = buildStepPlan(hasRefine, highlightRegen);
  let stepIndex = Number(job.step_index) || 0;

  if (stepIndex >= steps.length) {
    if (highlightRegen) {
      const partialState = await seedPartialFromAudit(sb, auditId);
      const { data: restarted, error: restartErr } = await sb
        .from("audit_analysis_jobs")
        .update({
          status: "pending",
          step_index: 0,
          partial_state: partialState,
          error_message: null,
          updated_at: new Date().toISOString(),
        })
        .eq("audit_id", auditId)
        .select("*")
        .single();
      if (restartErr) throw restartErr;
      job = restarted!;
      stepIndex = 0;
    } else {
      await sb.from("audit_analysis_jobs").update({
        status: "complete",
        updated_at: new Date().toISOString(),
      }).eq("audit_id", auditId);
      await autoPublishAudit(sb, auditId);
      return json({ ok: true, correlationId, status: "complete" });
    }
  }

  // Exactly one runner gets this step. Two kicks arriving together used to
  // both run it, and then every step after it, in lockstep.
  const claim = await claimJobStep(sb, auditId, stepIndex);
  if (!claim) {
    return json({ ok: true, correlationId, status: "in_progress", reason: "step_claimed_elsewhere", step: stepIndex });
  }
  // Read state as of the claim, not as of the select at the top.
  const partial = (claim.row.partial_state ?? {}) as Record<string, unknown>;
  // Untouched copy for a failed attempt, so a half-applied step is not saved.
  const partialAtClaim = { ...partial };
  const step = steps[stepIndex];

  try {
    if (step.kind === "top_level") {
      const result = await invokeAiAnalyze({ ...wizard, requestedSectionKeys: [], aiMode: "top_level_only" }, aiDeadlineAtMs, "top-level");
      partial.executiveSummary = result.executiveSummary;
      partial.findings = result.findings ?? [];
      partial.implementationTimeline = result.implementationTimeline ?? [];
      partial.addOnPlacements = result.addOnPlacements ?? [];
      if (highlightRegen) {
        partial.strengths = partial._preservedStrengths ?? partial.strengths ?? [];
      } else {
        partial.strengths = result.strengths ?? [];
        partial.sections = Array.isArray(partial.sections) ? partial.sections : [];
      }
    } else if (step.kind === "sections_for_highlight") {
      const placements = Array.isArray(partial.addOnPlacements)
        ? partial.addOnPlacements as Array<{ section_keys?: string[] }>
        : [];
      const keys = [
        ...new Set(
          placements.flatMap((p) =>
            Array.isArray(p.section_keys)
              ? p.section_keys.filter((k) => AUDIT_SECTION_KEYS_ALL.includes(String(k)))
              : [],
          ),
        ),
      ];
      if (keys.length > 0) {
        const result = await invokeAiAnalyze({
          ...wizard,
          requestedSectionKeys: keys,
          aiMode: "sections_only",
        }, aiDeadlineAtMs, `highlight sections ${keys.join(",")}`);
        const existing = Array.isArray(partial.sections)
          ? partial.sections as Array<Record<string, unknown>>
          : [];
        const regenKeys = new Set(keys);
        const kept = existing.filter((s) => !regenKeys.has(String(s.section_key ?? "")));
        partial.sections = [...kept, ...(result.sections ?? [])];
      }
      // Persist runs in a later invocation, so the keys must travel in
      // partial_state. An in-memory set here was always empty by then, which
      // made a highlight regen rewrite every section.
      partial.patchOnlySectionKeys = keys;
    } else if (step.kind === "section" && step.keys) {
      const result = await invokeAiAnalyze({
        ...wizard,
        requestedSectionKeys: step.keys,
        aiMode: "sections_only",
      }, aiDeadlineAtMs, `section ${step.keys.join(",")}`);
      const existing = Array.isArray(partial.sections) ? partial.sections as Array<Record<string, unknown>> : [];
      partial.sections = [...existing, ...(result.sections ?? [])];
    } else if (step.kind === "refine") {
      const sections = Array.isArray(partial.sections) ? partial.sections : [];
      const result = await invokeAiAnalyze({
        ...wizard,
        aiMode: "refine",
        refineBaseline: {
          companyName: wizard.companyName,
          clientName: wizard.clientName,
          executiveSummary: partial.executiveSummary,
          findings: partial.findings ?? [],
          strengths: partial.strengths ?? [],
          implementationTimeline: partial.implementationTimeline ?? [],
          sections,
        },
        auditContext: wizard.auditContext,
      }, aiDeadlineAtMs, "refine");
      partial.executiveSummary = result.executiveSummary;
      partial.findings = result.findings ?? partial.findings;
      partial.strengths = result.strengths ?? partial.strengths;
      partial.implementationTimeline = result.implementationTimeline ?? partial.implementationTimeline;
      if (Array.isArray(result.sections) && result.sections.length) {
        partial.sections = result.sections;
      }
    } else if (step.kind === "persist") {
      await persistAuditAnalysisResults(
        sb,
        auditId,
        {
          executiveSummary: String(partial.executiveSummary ?? ""),
          findings: (partial.findings as string[]) ?? [],
          strengths: (partial.strengths as string[]) ?? [],
          implementationTimeline: (partial.implementationTimeline as unknown[]) ?? [],
          sections: (partial.sections as Array<Record<string, unknown>>) ?? [],
          addOnPlacements: Array.isArray(partial.addOnPlacements)
            ? partial.addOnPlacements as Array<{
              template_slug: string;
              section_keys: string[];
              presenter_note: string;
            }>
            : [],
        },
        highlightRegen
          ? {
            // Empty means patch no section (no add-on landed on one).
            patchOnlySectionKeys: Array.isArray(partial.patchOnlySectionKeys)
              ? (partial.patchOnlySectionKeys as unknown[]).map(String)
              : [],
            preserveStrengthsFromAudit: true,
          }
          : undefined,
      );
      delete partial.stepAttempts;
      await writeClaimedStep(sb, auditId, claim.token, {
        status: "complete",
        step_index: steps.length,
        partial_state: partial,
        error_message: null,
      });
      // The analysis is the whole Klaviyo pipeline, so this is "done".
      await autoPublishAudit(sb, auditId);
      // The direct mail section sits outside the step machine: it reads the
      // persisted sections and counts, decides on its own gate, and writes its
      // own row, so a failure there can never stall or fail the analysis.
      await kickDirectMail(auditId);
      return json({ ok: true, correlationId, status: "complete", step: stepIndex });
    }

    const nextIndex = stepIndex + 1;
    delete partial.stepAttempts;
    const stillOwned = await writeClaimedStep(sb, auditId, claim.token, {
      status: nextIndex >= steps.length ? "complete" : "pending",
      step_index: nextIndex,
      partial_state: partial,
      error_message: null,
    });

    // A runner that lost the step must not start a second chain.
    if (stillOwned && nextIndex < steps.length) {
      await chainSelf(auditId, highlightRegen ? "highlight_regen" : undefined);
    }

    return json({
      ok: true,
      correlationId,
      status: nextIndex >= steps.length ? "complete" : "in_progress",
      step: stepIndex,
      nextStep: nextIndex,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = e instanceof AiStepError ? e.code : null;
    // Timeouts and transient errors retry up to 3 attempts, validation
    // failures once, each in a fresh invocation; then the step fails for good
    // (nothing automatic revives it, so we stop paying for it).
    const decision = decideStepFailure(classifyStepFailure(msg, code), attemptsForStep(partialAtClaim, stepIndex));
    const attemptState = { ...partialAtClaim, stepAttempts: { step: stepIndex, count: decision.attempts } };
    if (decision.action === "retry") {
      const stillOwned = await writeClaimedStep(sb, auditId, claim.token, {
        status: "pending",
        step_index: stepIndex,
        partial_state: attemptState,
        error_message: `attempt ${decision.attempts}/${decision.cap} failed: ${msg}`.slice(0, 1000),
      });
      if (stillOwned) {
        await sleep(2_000);
        await chainSelf(auditId, highlightRegen ? "highlight_regen" : undefined);
      }
      return json({ ok: true, correlationId, status: "in_progress", reason: "step_retry", step: stepIndex, attempt: decision.attempts });
    }
    const capped = decision.attempts >= decision.cap;
    await writeClaimedStep(sb, auditId, claim.token, {
      status: "failed",
      partial_state: capped ? { ...attemptState, attemptCapReached: true } : attemptState,
      error_message: (capped ? `${msg} (gave up after ${decision.attempts} attempts)` : msg).slice(0, 1000),
    });
    return json({ ok: false, correlationId, status: "failed", error: msg }, { status: 200 });
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  const correlationId = crypto.randomUUID();
  let body: { audit_id?: string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: { code: "bad_request", message: "Invalid JSON" }, correlationId }, { status: 400 });
  }

  const auditId = (body.audit_id ?? "").trim();
  const mode = (body.mode ?? "").trim();
  if (!auditId) {
    return json({ ok: false, error: { code: "bad_request", message: "Missing audit_id" }, correlationId }, { status: 400 });
  }

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const isServiceRole = isServiceRoleAuthorization(token);
  if (!isServiceRole) {
    try {
      // Staff with audit access only: the pipeline runs as the service role.
      await requireStaffUserId(req, "audits");
    } catch (e) {
      return json({
        ok: false,
        error: { code: "unauthorized", message: e instanceof Error ? e.message : "Unauthorized" },
        correlationId,
      }, { status: 401 });
    }
  }

  try {
    return await runPipeline(auditId, correlationId, { mode: mode || undefined });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: false, error: { code: "pipeline_failed", message: msg }, correlationId }, { status: 500 });
  }
});
