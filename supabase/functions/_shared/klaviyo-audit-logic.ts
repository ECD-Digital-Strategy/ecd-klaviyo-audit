// Pure decisions for the Klaviyo audit pipeline, kept apart from the edge
// functions so they can be tested without a database or the network.

// ---------------------------------------------------------------------------
// Profile scan claim
// ---------------------------------------------------------------------------

/** A 'running' profile scan untouched for this long belongs to a dead
 * invocation. A chunk runs up to ~148s and heartbeats every
 * PROFILE_SCAN_HEARTBEAT_MS, so a live scan never gets near this. Must match
 * the interval in claim_profile_scan_job (migration 20261110160000). */
export const PROFILE_SCAN_STALE_MS = 180_000;

/** How often a running chunk refreshes updated_at on its job row. */
export const PROFILE_SCAN_HEARTBEAT_MS = 20_000;

/** True when a 'running' row last touched at updatedAt is old enough to take
 * over. A row with no usable timestamp counts as stale. */
export function isRunningClaimStale(
  updatedAt: string | null | undefined,
  nowMs: number,
  staleAfterMs: number = PROFILE_SCAN_STALE_MS,
): boolean {
  const ms = updatedAt ? Date.parse(String(updatedAt)) : NaN;
  if (!Number.isFinite(ms)) return true;
  return nowMs - ms >= staleAfterMs;
}

// ---------------------------------------------------------------------------
// Reporting stage claim
// ---------------------------------------------------------------------------

/** A second reporting run for the same audit within this window exits. One run
 * takes 90-150s, so this only lets a genuinely dead run be redone. */
export const REPORTING_CLAIM_TTL_MS = 10 * 60_000;

/** The browser re-kicks the reporting stage only after this long with no run
 * logged, and only when the server holds no live claim. */
export const REPORTING_NUDGE_AFTER_MS = 6 * 60_000;

export function reportingClaimIsLive(
  startedAt: string | null | undefined,
  nowMs: number,
  ttlMs: number = REPORTING_CLAIM_TTL_MS,
): boolean {
  const ms = startedAt ? Date.parse(String(startedAt)) : NaN;
  if (!Number.isFinite(ms)) return false;
  return nowMs - ms < ttlMs;
}

// ---------------------------------------------------------------------------
// AI analysis step attempts
// ---------------------------------------------------------------------------

/** Total tries for one analysis step (timeouts and transient errors). */
export const AI_STEP_MAX_ATTEMPTS = 3;
/** Validation failures are retried once, so two tries in total. */
export const AI_STEP_MAX_VALIDATION_ATTEMPTS = 2;

export type StepFailureKind = "timeout" | "transient" | "validation" | "permanent";

const TIMEOUT_RE = /timed out|timeout|aborted|546|504/i;
const TRANSIENT_RE =
  /(^|[^0-9])(408|425|429|500|502|503|529)([^0-9]|$)|rate.?limit|overloaded|temporarily|unavailable|failed to send|fetch failed|connection (reset|closed|refused)|network/i;

export function classifyStepFailure(message: string, code?: string | null): StepFailureKind {
  const c = String(code ?? "");
  if (c === "validation_failed" || /validation/i.test(message)) return "validation";
  if (c === "timeout" || c === "provider_timeout" || TIMEOUT_RE.test(message)) return "timeout";
  if (TRANSIENT_RE.test(message)) return "transient";
  return "permanent";
}

export type StepAttempts = { step: number; count: number };

/** Attempts already spent on stepIndex, read from partial_state.stepAttempts.
 * A counter for another step does not count. */
export function attemptsForStep(partial: Record<string, unknown> | null | undefined, stepIndex: number): number {
  const raw = (partial ?? {}).stepAttempts as Partial<StepAttempts> | undefined;
  if (!raw || Number(raw.step) !== stepIndex) return 0;
  const n = Number(raw.count);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export type StepFailureDecision = { action: "retry" | "fail"; attempts: number; cap: number };

/** What to do after a step attempt failed. `priorAttempts` excludes the one that
 * just failed. Permanent errors fail at once; the rest retry until the cap. */
export function decideStepFailure(kind: StepFailureKind, priorAttempts: number): StepFailureDecision {
  const attempts = Math.max(0, priorAttempts) + 1;
  const cap = kind === "validation" ? AI_STEP_MAX_VALIDATION_ATTEMPTS : AI_STEP_MAX_ATTEMPTS;
  if (kind === "permanent") return { action: "fail", attempts, cap };
  return { action: attempts >= cap ? "fail" : "retry", attempts, cap };
}

/** True when the job failed because a step used up its attempts. Nothing
 * automatic may revive it; a person resuming it gets a fresh budget. */
export function attemptCapReached(partial: Record<string, unknown> | null | undefined): boolean {
  return (partial ?? {}).attemptCapReached === true;
}

// ---------------------------------------------------------------------------
// Flow report rollup
// ---------------------------------------------------------------------------

export type FlowRollup = {
  /** All channels. */
  recipients: number;
  emailRecipients: number;
  /** Email rows only (SMS has no opens). Null when the flow sent no email. */
  openRate: number | null;
  clickRate: number | null;
  /** All channels, recipient-weighted. */
  convRate: number;
  value: number;
  rpr: number;
  /** Distinct email messages in the flow; null when there are none. */
  emailMessageCount: number | null;
};

function isEmailChannel(channel: unknown): boolean {
  // Older reports had no send_channel grouping; those rows were email.
  if (channel == null || channel === "") return true;
  return String(channel).toLowerCase() === "email";
}

/** Roll Klaviyo flow-values rows (grouped by flow_id, flow_message_id,
 * send_channel) up to one entry per flow. */
export function rollupFlowReportRows(rows: unknown[]): Record<string, FlowRollup> {
  type Acc = {
    recipients: number;
    emailRecipients: number;
    open: number;
    click: number;
    conv: number;
    value: number;
    rpr: number;
    emailMessageIds: Set<string>;
  };
  const acc: Record<string, Acc> = {};
  for (const raw of rows ?? []) {
    const row = (raw ?? {}) as { groupings?: Record<string, unknown>; statistics?: Record<string, unknown> };
    const gid = row.groupings?.flow_id;
    if (!gid) continue;
    const id = String(gid);
    const stats = row.statistics ?? {};
    const recipients = Number(stats.recipients ?? 0) || 0;
    const a = acc[id] ??= {
      recipients: 0,
      emailRecipients: 0,
      open: 0,
      click: 0,
      conv: 0,
      value: 0,
      rpr: 0,
      emailMessageIds: new Set<string>(),
    };
    a.recipients += recipients;
    a.conv += (Number(stats.conversion_rate ?? 0) || 0) * recipients;
    a.value += Number(stats.conversion_value ?? 0) || 0;
    a.rpr += (Number(stats.revenue_per_recipient ?? 0) || 0) * recipients;
    if (isEmailChannel(row.groupings?.send_channel)) {
      a.emailRecipients += recipients;
      a.open += (Number(stats.open_rate ?? 0) || 0) * recipients;
      a.click += (Number(stats.click_rate ?? 0) || 0) * recipients;
      const mid = row.groupings?.flow_message_id;
      if (mid) a.emailMessageIds.add(String(mid));
    }
  }
  const out: Record<string, FlowRollup> = {};
  for (const [id, a] of Object.entries(acc)) {
    const denom = Math.max(1, a.recipients);
    const emailDenom = Math.max(1, a.emailRecipients);
    const hasEmail = a.emailRecipients > 0 || a.emailMessageIds.size > 0;
    out[id] = {
      recipients: a.recipients,
      emailRecipients: a.emailRecipients,
      openRate: hasEmail ? a.open / emailDenom : null,
      clickRate: hasEmail ? a.click / emailDenom : null,
      convRate: a.conv / denom,
      value: a.value,
      rpr: a.rpr / denom,
      emailMessageCount: a.emailMessageIds.size || null,
    };
  }
  return out;
}

function flowStatusRank(status: unknown): number {
  const s = String(status ?? "").toLowerCase();
  if (s.includes("live")) return 0;
  if (s.includes("manual")) return 1;
  if (s.includes("draft")) return 3;
  if (s.includes("archiv")) return 4;
  return 2;
}

/** Flow ids to report on, live flows first, so the report cap never spends
 * its slots on drafts while a live flow is left out. Stable within a rank. */
export function orderFlowIdsForReport(
  rows: Array<{ flow_id?: unknown; status?: unknown; archived?: unknown }>,
  max: number,
): string[] {
  return rows
    .map((r, i) => ({ id: String(r.flow_id ?? ""), rank: r.archived === true ? 4 : flowStatusRank(r.status), i }))
    .filter((r) => r.id)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, max)
    .map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Klaviyo HTTP retry pacing
// ---------------------------------------------------------------------------

/** Parse a Retry-After header (seconds or an HTTP date) into ms, or null. */
export function parseRetryAfterMs(header: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - nowMs);
}

/** Wait before retry attempt i+1 (i is 1-based). Honours Retry-After, capped
 * so one throttled call cannot eat the edge wall clock. */
export function retryDelayMs(attempt: number, retryAfterMs: number | null | undefined, capMs = 30_000): number {
  const backoff = 400 * Math.pow(2, attempt - 1);
  const wanted = retryAfterMs != null && retryAfterMs > 0 ? Math.max(backoff, retryAfterMs) : backoff;
  return Math.min(capMs, wanted);
}

// ---------------------------------------------------------------------------
// Hidden flags carried across a regeneration
// ---------------------------------------------------------------------------

/** Rebuild a hidden-flags array for `next` items from the flags stored against
 * `prev` items: an item whose text is unchanged keeps its flag; when nothing
 * matches by text but the counts match, flags carry over by position. */
export function carryHiddenFlags(
  prev: unknown[] | null | undefined,
  prevHidden: unknown[] | null | undefined,
  next: unknown[],
): boolean[] {
  const prevItems = Array.isArray(prev) ? prev.map((p) => normalizeItem(p)) : [];
  const flags = Array.isArray(prevHidden) ? prevHidden.map(Boolean) : [];
  if (!flags.some(Boolean)) return next.map(() => false);
  const hiddenByText = new Map<string, boolean>();
  prevItems.forEach((text, i) => {
    if (text && !hiddenByText.has(text)) hiddenByText.set(text, Boolean(flags[i]));
  });
  const nextItems = next.map((n) => normalizeItem(n));
  const anyTextMatch = nextItems.some((t) => t && hiddenByText.has(t));
  if (!anyTextMatch && prevItems.length === nextItems.length) {
    return nextItems.map((_, i) => Boolean(flags[i]));
  }
  return nextItems.map((t) => Boolean(t && hiddenByText.get(t)));
}

function normalizeItem(item: unknown): string {
  if (typeof item === "string") return item.trim();
  try {
    return JSON.stringify(item ?? "");
  } catch {
    return "";
  }
}
