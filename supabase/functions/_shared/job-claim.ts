// Owning one step of an audit_analysis_jobs row, atomically.
//
// Both analysis pipelines (Klaviyo and web) run as a chain of short
// invocations, and several things can start one: the server chain itself, the
// profile-scan finish, the watchdog, and the browser tab watching progress.
// They used to read the row, check "not running", and then write "running" as
// separate steps. Two kicks landing within a second both passed the check, and
// from then on the two runs stayed in lockstep: the slower one's "pending" write
// cleared the faster one's "running" marker, which let its next step through
// too. 3 of 12 Klaviyo analyses ran every AI call twice (HigherDose on
// 2026-09-02 made 13 calls where 7 were needed), and the losing run left its
// row on "pending" for good, which the watchdog then re-kicked every five
// minutes, forever.
//
// The fix is a compare-and-set. Postgres re-checks an UPDATE's WHERE clause
// after taking the row lock, so of two runners asking to move step N from
// pending to running, exactly one gets a row back. The winner holds a random
// token, and every later write about that step is conditional on it: a runner
// that has lost the step can no longer overwrite the one that holds it.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { attemptsForStep, decideStepFailure } from "./klaviyo-audit-logic.ts";

type Sb = SupabaseClient;
type JobRow = Record<string, unknown>;

export type StepClaim = { token: string; row: JobRow };

/** Take step `stepIndex` of the audit's job, or return null if another runner
 * already has it (or the job has moved on). The returned row is the state as of
 * the claim, so read partial_state from it rather than from an earlier select. */
export async function claimJobStep(sb: Sb, auditId: string, stepIndex: number): Promise<StepClaim | null> {
  const token = crypto.randomUUID();
  const { data, error } = await sb
    .from("audit_analysis_jobs")
    .update({ status: "running", claim_token: token, updated_at: new Date().toISOString() })
    .eq("audit_id", auditId)
    .eq("step_index", stepIndex)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? { token, row: data as JobRow } : null;
}

/** Write the outcome of a claimed step. Returns false when the claim was lost
 * in the meantime, in which case the caller must not chain the next step. */
export async function writeClaimedStep(
  sb: Sb,
  auditId: string,
  token: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await sb
    .from("audit_analysis_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("audit_id", auditId)
    .eq("claim_token", token)
    .select("audit_id");
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

/** A "running" row older than the edge wall clock belongs to a dead invocation.
 * Hand it back to "pending" only if it is still that same dead run, so a runner
 * that claimed it a moment ago is never knocked off. */
export async function releaseStaleRun(sb: Sb, auditId: string, staleBeforeIso: string): Promise<void> {
  const { error } = await sb
    .from("audit_analysis_jobs")
    .update({ status: "pending", updated_at: new Date().toISOString() })
    .eq("audit_id", auditId)
    .eq("status", "running")
    .lt("updated_at", staleBeforeIso);
  if (error) throw error;
}

/** Like releaseStaleRun, but a dead run counts as a timed-out attempt at its
 * step: the step goes back to pending until it has used its attempts, then
 * the job is marked failed so nothing keeps paying for it. Used for Klaviyo
 * analysis jobs only. Returns what happened, or "noop" when the row was no
 * longer that stale run. */
export async function releaseStaleRunWithBudget(
  sb: Sb,
  auditId: string,
  job: JobRow,
  staleBeforeIso: string,
): Promise<"released" | "failed" | "noop"> {
  const partial = (job.partial_state ?? {}) as Record<string, unknown>;
  const step = Number(job.step_index) || 0;
  const decision = decideStepFailure("timeout", attemptsForStep(partial, step));
  const nextPartial: Record<string, unknown> = { ...partial, stepAttempts: { step, count: decision.attempts } };
  const patch = decision.action === "fail"
    ? {
      status: "failed",
      error_message:
        `Step ${step} did not finish within the edge time limit after ${decision.attempts} attempts. Resume to try again.`,
      partial_state: { ...nextPartial, attemptCapReached: true },
    }
    : { status: "pending", partial_state: nextPartial };
  const { data, error } = await sb
    .from("audit_analysis_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("audit_id", auditId)
    .eq("status", "running")
    .lt("updated_at", staleBeforeIso)
    .select("audit_id");
  if (error) throw error;
  if (!Array.isArray(data) || data.length === 0) return "noop";
  return decision.action === "fail" ? "failed" : "released";
}

/** Read the job row, creating it if there is none. Two first kicks racing to
 * create it used to make the loser fail with a unique violation, which the
 * browser reported as "failed to start" although the analysis was running. */
export async function ensureJobRow(
  sb: Sb,
  auditId: string,
  clientId: string,
  initialPartial: Record<string, unknown>,
): Promise<JobRow> {
  const select = () => sb.from("audit_analysis_jobs").select("*").eq("audit_id", auditId).maybeSingle();
  const { data: existing } = await select();
  if (existing) return existing as JobRow;
  const { data, error } = await sb
    .from("audit_analysis_jobs")
    .insert({ audit_id: auditId, client_id: clientId, status: "pending", step_index: 0, partial_state: initialPartial })
    .select("*")
    .single();
  if (!error && data) return data as JobRow;
  if (error && (error as { code?: string }).code === "23505") {
    const { data: winner } = await select();
    if (winner) return winner as JobRow;
  }
  throw error ?? new Error("Could not create the analysis job");
}
