import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { isServiceRoleAuthorization, requireStaffUserId } from "../_shared/auth.ts";
import { fetchPlatformBenchmarkConfig, getFlowBenchmarks } from "../_shared/benchmarks.ts";
import { computeCampaignRevenuePerRecipient } from "../_shared/campaign-metrics.ts";
import { buildRevenueBreakdown } from "../_shared/revenue-breakdown.ts";
import { buildDeliverabilitySnapshot, extractBounceSpam } from "../_shared/deliverability.ts";
import { flowInventoryHasSmsMarketing } from "../_shared/competing-sms-detect.ts";
import {
  resolveWebsiteUrlForClient,
  runCompetingSmsWebsiteScan,
} from "../_shared/competing-sms-scan.ts";
import { KLAVIYO_BASE, KLAVIYO_REVISION, resolveKlaviyoRevision } from "../_shared/klaviyo-api.ts";

// Stage machine: each stage runs in its own edge invocation with a fresh ~150s
// budget. `config` is the entry point the frontend calls; subsequent stages
// chain via self-POST so long accounts can't exceed one invocation's budget.
//
//   stage=config            -> fetch account + snapshots + resolve/cache conversion metric, chain reporting
//   stage=reporting         -> run 30d/90d values reports + flow_performance + rollups, chain profile if full
//   stage=profile           -> seed profile scan job + chain resume_profile_scan
//   stage=resume_profile_scan -> process one chunk of /api/profiles/ and self-chain if truncated
//
// Back-compat: if neither `stage` nor `mode` is provided, behave like `config`
// (so older clients keep working through the same entry point).
type Stage =
  | "config"
  | "reporting"
  | "profile"
  | "resume_profile_scan"
  | "backfill_revenue_breakdown"
  | "backfill_deliverability"
  | "backfill_segment_definitions"
  | "fetch_campaign_email";

type FetchInput = {
  audit_id?: string;
  client_id?: string;
  api_key?: string;
  revision?: string;
  stage?: Stage;
  campaign_id?: string;
  persist?: boolean;
  // Legacy alias kept for old clients that only know `mode: "resume_profile_scan"`.
  mode?: "resume_profile_scan";
  profile_scan?: "full" | "fast";
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const KMS_ENCRYPTION_KEY = Deno.env.get("KMS_ENCRYPTION_KEY") ?? "";

/** Flow-id cap for values-reports filter. Flamingo Estate has >50 flows. */
const MAX_REPORT_IDS = 100;
/** 5 pages × 100 = 500 email campaigns max per snapshot. */
const MAX_CAMPAIGN_PAGES = 5;
const CAMPAIGN_SNAPSHOT_CAP = 500;
const MAX_LIST_PAGES = 5;
/** Lightweight segment names for groupNameMap (100/page × 10 = 1000). */
const MAX_SEGMENT_NAME_PAGES = 10;
/** Segments with definitions for segment inventory snapshots (10/page × 20 = 200; Klaviyo max page size is 10 when definition is requested). */
const MAX_SEGMENT_DEFINITION_PAGES = 20;
const SEGMENTS_NAMES_ONLY_PATH =
  "/api/segments/?page%5Bsize%5D=100&fields%5Bsegment%5D=name,created,updated";
const SEGMENTS_WITH_DEFINITIONS_PATH =
  "/api/segments/?page%5Bsize%5D=10&fields%5Bsegment%5D=name,created,updated,definition,is_active,is_processing";
const SEGMENT_BY_ID_FIELDS =
  "fields%5Bsegment%5D=name,created,updated,definition,is_active,is_processing";
const LIST_BY_ID_FIELDS = "fields%5Blist%5D=name,created,updated";
const CAMPAIGNS_WITH_AUDIENCES_PATH =
  "/api/campaigns/?filter=equals(messages.channel,'email')&fields%5Bcampaign%5D=name,status,created_at,updated_at,audiences";
const METRICS_MAX_PAGES = 5;

type EcdGroupNameEntry = { name: string; kind: "segment" | "list" };

function buildGroupNameMap(lists: any[], segments: any[]): Record<string, EcdGroupNameEntry> {
  const map: Record<string, EcdGroupNameEntry> = {};
  for (const item of lists ?? []) {
    if (!item?.id) continue;
    map[item.id] = { name: item.attributes?.name ?? item.id, kind: "list" };
  }
  for (const item of segments ?? []) {
    if (!item?.id) continue;
    map[item.id] = { name: item.attributes?.name ?? item.id, kind: "segment" };
  }
  return map;
}

function collectAudienceIdsFromCampaigns(campaigns: any[]): string[] {
  const ids = new Set<string>();
  for (const c of campaigns ?? []) {
    const aud = c?.attributes?.audiences;
    if (!aud || typeof aud !== "object") continue;
    for (const id of (aud as any).included ?? []) {
      if (id) ids.add(String(id));
    }
    for (const id of (aud as any).excluded ?? []) {
      if (id) ids.add(String(id));
    }
  }
  return [...ids];
}

async function hydrateAudienceIds(params: {
  apiKey: string;
  revision: string;
  groupNameMap: Record<string, EcdGroupNameEntry>;
  campaigns: any[];
}): Promise<{
  groupNameMap: Record<string, EcdGroupNameEntry>;
  hydratedSegments: any[];
}> {
  const map = { ...params.groupNameMap };
  const hydratedSegments: any[] = [];
  const missing = collectAudienceIdsFromCampaigns(params.campaigns).filter((id) => !map[id]);

  for (const id of missing) {
    const segRes = await fetchWithRetry(
      () => klaviyoFetch(params.apiKey, params.revision, `/api/segments/${id}/?${SEGMENT_BY_ID_FIELDS}`),
      3,
    );
    if (segRes.ok && segRes.body?.data?.id) {
      const seg = segRes.body.data;
      map[id] = { name: seg.attributes?.name ?? id, kind: "segment" };
      hydratedSegments.push(seg);
      continue;
    }
    if (segRes.status !== 404) continue;

    const listRes = await fetchWithRetry(
      () => klaviyoFetch(params.apiKey, params.revision, `/api/lists/${id}/?${LIST_BY_ID_FIELDS}`),
      3,
    );
    if (listRes.ok && listRes.body?.data?.id) {
      const list = listRes.body.data;
      map[id] = { name: list.attributes?.name ?? id, kind: "list" };
    }
  }

  return { groupNameMap: map, hydratedSegments };
}

function mergeSegmentItemsForSnapshots(primary: any[], extra: any[]): any[] {
  const byId = new Map<string, any>();
  for (const s of primary ?? []) {
    if (s?.id) byId.set(s.id, s);
  }
  for (const s of extra ?? []) {
    if (s?.id && !byId.has(s.id)) byId.set(s.id, s);
  }
  return [...byId.values()];
}
/** Skip optional email HTML fetch if less than this many ms remain before deadline. */
const MIN_SLACK_MS_EMAIL_HTML = 15_000;
// Full enumeration is required for exact consent/suppression counts; Klaviyo has
// no aggregate-only endpoint for those metrics. The unpartitioned first path this
// used to start from is gone on purpose: see the partitioned-scan block below.
/** Breather between profile pages. The loop used to fire pages back-to-back for
 * the full 148s stage budget, and on one large account that sustained hammering
 * tripped Klaviyo's CDN into 403-ing every request roughly 20 minutes into a
 * scan. Costs ~20% throughput; a scan that finishes slowly beats one that is
 * blocked and never finishes. */
const PROFILE_PAGE_DELAY_MS = 250;

// KEYSET SCAN. One account blocked at ~185k profiles on every attempt (183,000 /
// 191,700 / 184,700 across passes) regardless of pacing or elapsed time, so the
// wall tracks cursor DEPTH: past roughly 1,850 pages of one cursor the CDN
// rejects everything and waiting cannot help. The scan therefore never lets a
// single cursor get deep. Every PROFILE_CURSOR_PAGE_LIMIT pages it abandons the
// opaque cursor and starts a fresh, shallow one anchored at the created
// timestamp of the last profile it saw.
//
// Bounded date buckets were the first attempt and Klaviyo rejects them outright:
// "Ascending sort may only be used with greater-than", i.e. an ascending scan
// cannot carry an upper bound. That leaves exactly this shape, which is the
// textbook keyset pattern anyway: sort ascending, filter on greater-than, walk
// forward. The anchor rides inside next_path and Klaviyo echoes the filter on
// every links.next, so position survives a resume with no extra state.
/** Pages to follow on one cursor before re-anchoring. 150 pages is ~15k
 * profiles, an order of magnitude clear of the observed wall. */
const PROFILE_CURSOR_PAGE_LIMIT = 150;

/** First page of a scan segment. No filter starts from the oldest profile;
 * an anchor continues strictly after that created timestamp. */
/** Klaviyo's page[cursor] is base64 of "next::created::<ts>::id::<id>", so the
 * scan's exact position is recoverable from the cursor itself.
 *
 * This is what lets a BLOCKED scan escape. Re-anchoring only happened
 * proactively every 150 pages; when a cursor got rejected, the job parked with
 * that same poisoned cursor and every later resume replayed it, which is how one
 * account sat at ~191k through five consecutive blocks. Decoding the position
 * turns "retry the cursor that just failed" into "start a fresh shallow cursor
 * from where we actually got to".
 *
 * Best effort by design: this reads an undocumented internal format, so an
 * unexpected shape returns null and the caller simply parks as before. */
function anchorFromCursorPath(path: string): string | null {
  try {
    const query = path.split("?")[1];
    if (!query) return null;
    const cursor = new URLSearchParams(query).get("page[cursor]");
    if (!cursor) return null;
    // The created value itself contains colons ("14:34:35+00:00"), so match
    // lazily up to the ::id:: separator rather than splitting on ":".
    const m = /created::(.*?)::id::/.exec(atob(cursor));
    if (!m?.[1]) return null;
    const ms = Date.parse(m[1].trim().replace(" ", "T"));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  } catch {
    return null;
  }
}

/** How far past the recovered anchor to restart after N consecutive blocks.
 * The first couple of retries re-anchor exactly, losing nothing. If the block
 * survives that, the cause is a specific record just past the anchor that
 * Klaviyo cannot serve, so the scan steps over a widening window to get past it.
 * Skipping profiles is a real cost, which is why it is a late resort. */
function anchorNudgeMs(consecutiveBlocks: number): number {
  const minutes = [0, 0, 1, 60, 360, 1440];
  return (minutes[Math.min(consecutiveBlocks, minutes.length - 1)] ?? 1440) * 60_000;
}

function profileKeysetPath(afterCreatedIso: string | null): string {
  const qs = new URLSearchParams();
  qs.set("page[size]", "100");
  qs.set("additional-fields[profile]", "subscriptions");
  // Ascending order is what makes "continue after the last one seen" meaningful.
  qs.set("sort", "created");
  if (afterCreatedIso) qs.set("filter", `greater-than(created,${afterCreatedIso})`);
  return `/api/profiles/?${qs.toString()}`;
}
/** Per-client cached metric is honored for this long before we re-probe. */
const METRIC_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Klaviyo values-reports are documented at 1/s burst + 2/min steady. */
const REPORTING_TOKENS_PER_MIN = 2;
const REPORTING_BURST = 1;
/** Hard timeout on any single Klaviyo HTTP call so a hung socket can't burn our whole stage budget. */
const KLAVIYO_HTTP_TIMEOUT_MS = 30_000;

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type, accept, origin, referer, user-agent",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
    ...init,
  });
}

function redactSecrets(msg: string) {
  return msg.replace(/pk_[a-zA-Z0-9_\\-]+/g, "pk_[REDACTED]");
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

// Staff with audit access only: every stage reads keys and writes snapshots
// with the service role, so a bare signed-in session is not enough.
async function requireAuthenticatedUser(req: Request) {
  await requireStaffUserId(req, "audits");
}

function b64encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}

function b64decode(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function deriveAesKey(secret: string) {
  const enc = new TextEncoder();
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function encryptionSecret() {
  return (KMS_ENCRYPTION_KEY || SUPABASE_SERVICE_ROLE_KEY || "").trim();
}

async function encryptString(plaintext: string) {
  const secret = encryptionSecret();
  if (!secret) throw new Error("Encryption secret is missing");
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return {
    alg: "AES-256-GCM",
    ciphertext: b64encode(new Uint8Array(ct)),
    iv: b64encode(iv),
  };
}

async function decryptString(ciphertextB64: string, ivB64: string) {
  const secret = encryptionSecret();
  if (!secret) throw new Error("Encryption secret is missing");
  const key = await deriveAesKey(secret);
  const iv = b64decode(ivB64);
  const ct = b64decode(ciphertextB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

// ---------------------------------------------------------------------------
// Klaviyo HTTP helpers
// ---------------------------------------------------------------------------

async function klaviyoFetch(apiKey: string, revision: string, path: string) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), KLAVIYO_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${KLAVIYO_BASE}${path}`, {
      headers: {
        accept: "application/json",
        authorization: `Klaviyo-API-Key ${apiKey}`,
        revision,
      },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    const aborted = (e as any)?.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 504 : 0,
      body: aborted ? `Klaviyo request timed out after ${KLAVIYO_HTTP_TIMEOUT_MS}ms` : String(e),
    };
  } finally {
    clearTimeout(t);
  }
}

async function fetchWithRetry(fn: () => Promise<{ ok: boolean; status: number; body: any }>, attempts = 5) {
  let last: any = null;
  for (let i = 1; i <= attempts; i++) {
    const res = await fn();
    last = res;
    if (res.ok) return res;
    if (![429, 500, 502, 503, 504].includes(res.status)) return res;
    const delay = 400 * Math.pow(2, i - 1);
    await sleep(delay);
  }
  return last;
}

async function klaviyoPaged(apiKey: string, revision: string, path: string, maxPages = 10) {
  const out: any[] = [];
  let next = path;
  let truncated = false;
  for (let i = 0; i < maxPages && next; i++) {
    const res = await fetchWithRetry(() => klaviyoFetch(apiKey, revision, next), 3);
    if (!res.ok) return { ok: false as const, status: res.status, body: res.body, items: out, truncated: false };
    const items = res.body?.data ?? [];
    out.push(...items);
    const nextUrl: string | null = res.body?.links?.next ?? null;
    if (!nextUrl) break;
    if (i === maxPages - 1) {
      truncated = true;
      break;
    }
    const u = new URL(nextUrl);
    next = `${u.pathname}${u.search}`;
  }
  return { ok: true as const, status: 200, items: out, truncated };
}

// ---------------------------------------------------------------------------
// Profile scan helpers
// ---------------------------------------------------------------------------

type ProfileChunkOk = {
  ok: true;
  totalProfiles: number;
  subscribed: number;
  smsSubscribed: number;
  active90d: number;
  suppressed: number;
  truncated: boolean;
  nextPath: string | null;
};

async function computeProfileSnapshotChunk(params: {
  apiKey: string;
  revision: string;
  since90Iso: string;
  startPath: string | null;
  totalProfiles: number;
  subscribed: number;
  smsSubscribed: number;
  active90d: number;
  suppressed: number;
  deadlineAtMs: number;
}): Promise<ProfileChunkOk | { ok: false; status: number; body: any }> {
  const since90Ms = Date.parse(params.since90Iso);
  let totalProfiles = params.totalProfiles;
  let subscribed = params.subscribed;
  let smsSubscribed = params.smsSubscribed;
  let active90d = params.active90d;
  let suppressed = params.suppressed;
  // Fresh scans start at the oldest profile; resumed scans continue on whatever
  // cursor (and therefore whatever anchor) they stopped at.
  let next = params.startPath ?? profileKeysetPath(null);
  // Pages followed on the CURRENT cursor, and the newest created timestamp seen,
  // which together drive re-anchoring before any cursor gets deep.
  let pagesOnCursor = 0;
  let lastCreated: string | null = null;

  for (;;) {
    if (Date.now() >= params.deadlineAtMs) {
      return {
        ok: true,
        totalProfiles,
        subscribed,
        smsSubscribed,
        active90d,
        suppressed,
        truncated: true,
        nextPath: next,
      };
    }
    const res = await fetchWithRetry(() => klaviyoFetch(params.apiKey, params.revision, next), 3);
    if (!res.ok) {
      return { ok: false, status: res.status, body: res.body };
    }
    const items = res.body?.data ?? [];
    pagesOnCursor += 1;
    for (const p of items) {
      totalProfiles += 1;
      // Ascending sort means the last profile on the last page carries the
      // newest created timestamp, which is the anchor for the next segment.
      const created = p?.attributes?.created;
      if (typeof created === "string" && created) lastCreated = created;
      const emailConsent = String(p?.attributes?.subscriptions?.email?.marketing?.consent ?? "").toUpperCase();
      const isEmailSubscribed = emailConsent === "SUBSCRIBED";
      if (isEmailSubscribed) subscribed += 1;
      const smsConsent = String(p?.attributes?.subscriptions?.sms?.marketing?.consent ?? "").toUpperCase();
      if (smsConsent === "SUBSCRIBED") smsSubscribed += 1;
      const suppressionList = p?.attributes?.subscriptions?.email?.marketing?.suppression;
      if (Array.isArray(suppressionList) ? suppressionList.length > 0 : suppressionList != null) {
        suppressed += 1;
      }
      if (isEmailSubscribed) {
        const updated = p?.attributes?.updated;
        const updatedMs = typeof updated === "string" ? Date.parse(updated) : NaN;
        if (Number.isFinite(updatedMs) && Number.isFinite(since90Ms) && updatedMs >= since90Ms) {
          active90d += 1;
        }
      }
    }
    const nextUrl: string | null = res.body?.links?.next ?? null;
    if (!nextUrl) {
      // No further page on this cursor and ascending order means we have reached
      // the newest profile: the account is fully counted.
      return {
        ok: true,
        totalProfiles,
        subscribed,
        smsSubscribed,
        active90d,
        suppressed,
        truncated: false,
        nextPath: null,
      };
    }
    if (pagesOnCursor >= PROFILE_CURSOR_PAGE_LIMIT && lastCreated) {
      // Re-anchor before this cursor gets deep enough to be rejected. Dropping
      // the opaque cursor for a fresh greater-than filter is the whole point:
      // depth resets to zero while position is preserved.
      //
      // Caveat: the bound is exclusive, so profiles sharing the anchor's exact
      // created timestamp are skipped. Klaviyo's timestamps carry sub-second
      // precision and this happens at most once per 15k profiles, so the
      // undercount is negligible next to not finishing at all.
      next = profileKeysetPath(lastCreated);
      pagesOnCursor = 0;
      await sleep(PROFILE_PAGE_DELAY_MS);
      continue;
    }
    const u = new URL(nextUrl);
    next = `${u.pathname}${u.search}`;
    // Pace the next request. Sustained back-to-back paging is what the CDN
    // reacts to, not any single call.
    await sleep(PROFILE_PAGE_DELAY_MS);
  }
}

/**
 * Fire-and-forget POST to this same edge function with the given stage payload.
 * We await only long enough to confirm the request left the isolate; the
 * downstream invocation continues on its own fresh budget.
 */
async function chainStage(stage: Stage, auditId: string, extra: Record<string, unknown> = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  const url = `${SUPABASE_URL}/functions/v1/klaviyo_fetch_snapshot`;
  const body: Record<string, unknown> = { stage, audit_id: auditId, ...extra };
  try {
    await Promise.race([
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: SUPABASE_SERVICE_ROLE_KEY,
        },
        body: JSON.stringify(body),
      }),
      sleep(4_000),
    ]);
  } catch { /* best effort */ }
}

async function chainAuditAnalysis(auditId: string) {
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
        body: JSON.stringify({ audit_id: auditId }),
      }),
      sleep(4_000),
    ]);
  } catch { /* best effort */ }
}

async function finalizeProfileScan(
  sb: ReturnType<typeof assertServiceClient>,
  auditId: string,
  totalProfiles: number,
  subscribed: number,
  smsSubscribed: number,
  active90d: number,
  suppressed: number,
  stagedRpr: number | null,
  /** True when the scan could not reach the end of the account (an upstream
   * block it could not get past). The counts are then real but incomplete, so
   * they publish as lower bounds rather than leaving the report stuck on
   * "full profile scan in progress" indefinitely. */
  partial = false,
) {
  const { data: rollups } = await sb.from("klaviyo_reporting_rollups").select("id, computed").eq("audit_id", auditId);
  if (!rollups?.length) return;

  const accountSnapshotPatch = {
    total_profiles_count: totalProfiles,
    email_subscribed_profiles_count: subscribed,
    sms_subscribed_profiles_count: smsSubscribed,
    active_profiles_90d_count: active90d,
    suppressed_profiles_count: suppressed,
    // Truncated flags already exist for exactly this meaning, so a partial scan
    // reuses them instead of inventing a parallel concept.
    email_subscribed_profiles_truncated: partial,
    active_profiles_90d_truncated: partial,
    suppressed_profiles_truncated: partial,
    total_profiles_truncated: partial,
    profile_scan_status: partial ? "partial" : "complete",
    computed_at: new Date().toISOString(),
  };

  let finalRprForAudit: number | null = stagedRpr;
  for (const row of rollups) {
    const c = (row.computed ?? {}) as Record<string, unknown>;
    const existing = (c.account_snapshot ?? {}) as Record<string, unknown>;
    const prevDm = (c.derived_metrics ?? {}) as Record<string, unknown>;
    const prevRpr = prevDm.revenue_per_recipient;
    const rprMerged =
      stagedRpr ??
      (typeof prevRpr === "number" && Number.isFinite(prevRpr) ? prevRpr : null);
    if (finalRprForAudit == null && rprMerged != null) finalRprForAudit = rprMerged;
    const derived_metrics = {
      ...prevDm,
      list_size: totalProfiles,
      monthly_engagement: subscribed,
      revenue_per_recipient: rprMerged,
    };
    const account_snapshot = { ...existing, ...accountSnapshotPatch };
    const computed = { ...c, account_snapshot, derived_metrics };
    await mustSucceed("update klaviyo_reporting_rollups profile merge", sb.from("klaviyo_reporting_rollups").update({ computed }).eq("id", row.id));
  }

  await mustSucceed("update audits profile metrics", sb.from("audits").update({
    list_size: totalProfiles,
    monthly_traffic: subscribed,
    aov: finalRprForAudit ?? 0,
  }).eq("id", auditId));

  await mustSucceed("complete profile scan job", sb.from("klaviyo_profile_scan_jobs").update({
    status: "complete",
    // A partial finalize keeps next_path so the scan can still be resumed by
    // hand (or by a later fix) from exactly where the block stopped it.
    next_path: partial ? undefined : null,
    total_profiles: totalProfiles,
    subscribed,
    active90d,
    suppressed,
    error_message: partial
      ? `partial: blocked upstream after ${totalProfiles} profiles; counts published as lower bounds`
      : null,
    updated_at: new Date().toISOString(),
  }).eq("audit_id", auditId));

  await chainAuditAnalysis(auditId);
}

/** How long to wait before retrying after N consecutive upstream blocks.
 * The watchdog fires every ~5 minutes, which is right for a one-off blip and
 * useless against a CDN block that lasts an hour: one account burned 11 straight
 * resumes over 50 minutes, every one rejected instantly. Backing off gives the
 * block time to lapse instead of confirming the traffic pattern that caused it.
 * Capped so a scan always makes another attempt within the hour. */
function blockedCooldownMs(consecutiveBlocks: number): number {
  if (consecutiveBlocks <= 1) return 0;
  return Math.min(45 * 60_000, 5 * 60_000 * Math.pow(2, consecutiveBlocks - 2));
}

async function handleResumeProfileScan(auditId: string, correlationId: string): Promise<Response> {
  const sb = assertServiceClient();
  // Honour the cooldown BEFORE claiming: claiming flips the row to running, and
  // a rejected attempt would then rewrite updated_at and restart the clock.
  const { data: pre } = await sb.from("klaviyo_profile_scan_jobs")
    .select("status, resume_attempts, updated_at, error_message")
    .eq("audit_id", auditId)
    .maybeSingle();
  if (pre && pre.status === "pending") {
    const blocks = Number(pre.resume_attempts ?? 0);
    // The long cooldown exists because replaying a request that just failed
    // needs time for the upstream condition to lapse. A re-anchored scan is not
    // a replay: it is a brand-new shallow query from a recovered position, so
    // making it wait 45 minutes only delays the recovery it was built for.
    const reAnchored = /re-anchored at/.test(String(pre.error_message ?? ""));
    const waitMs = reAnchored ? 60_000 : blockedCooldownMs(blocks);
    const sinceMs = pre.updated_at ? Date.now() - Date.parse(String(pre.updated_at)) : Number.MAX_SAFE_INTEGER;
    if (waitMs > 0 && sinceMs < waitMs) {
      return json({
        ok: true,
        correlationId,
        profile_metrics_status: "in_progress",
        reason: "cooling_down",
        retry_in_s: Math.ceil((waitMs - sinceMs) / 1000),
      });
    }
  }
  const { data: claimRows, error: claimErr } = await sb.rpc("claim_profile_scan_job", { p_audit_id: auditId });
  if (claimErr) {
    return json({ ok: false, error: { code: "claim_failed", message: claimErr.message }, correlationId }, { status: 500 });
  }
  const claimed = (Array.isArray(claimRows) ? claimRows[0] : claimRows) as Record<string, unknown> | null | undefined;
  if (!claimed) {
    const { data: job } = await sb.from("klaviyo_profile_scan_jobs")
      .select("status, updated_at")
      .eq("audit_id", auditId)
      .maybeSingle();
    if (!job) return json({ ok: false, error: { code: "not_found", message: "No profile scan job" }, correlationId }, { status: 404 });
    if (job.status === "complete") return json({ ok: true, correlationId, profile_metrics_status: "complete" });
    if (job.status === "skipped") return json({ ok: true, correlationId, profile_metrics_status: "complete" });
    if (job.status === "failed") return json({ ok: false, correlationId, profile_metrics_status: "failed" });
    const updatedMs = job.updated_at ? Date.parse(String(job.updated_at)) : 0;
    const staleRunning = job.status === "running" && updatedMs > 0 && Date.now() - updatedMs >= 90_000;
    if (staleRunning) {
      await sb.from("klaviyo_profile_scan_jobs").update({
        status: "pending",
        updated_at: new Date().toISOString(),
      }).eq("audit_id", auditId);
      return handleResumeProfileScan(auditId, correlationId);
    }
    return json({ ok: true, correlationId, profile_metrics_status: "in_progress", reason: "already_running" });
  }

  const startedAt = Date.now();
  // Full 148s headroom (was 145s). We don't chain until after this returns so
  // we can use the full edge budget.
  const deadlineAtMs = startedAt + 148_000;
  let apiKey: string;
  try {
    const { data: sec, error } = await sb.from("client_secrets").select("*").eq("client_id", claimed.client_id as string).maybeSingle();
    if (error) throw error;
    if (!sec?.klaviyo_private_key_ciphertext || !sec?.klaviyo_private_key_iv) throw new Error("No Klaviyo key for client");
    apiKey = await decryptString(sec.klaviyo_private_key_ciphertext, sec.klaviyo_private_key_iv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Key error";
    await sb.from("klaviyo_profile_scan_jobs").update({
      status: "failed",
      error_message: msg.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("audit_id", auditId);
    await logStageRun(sb, {
      correlationId,
      auditId,
      clientId: (claimed.client_id as string) ?? null,
      stage: "resume_profile_scan",
      status: "error",
      revision: String(claimed.revision ?? KLAVIYO_REVISION),
      elapsedMs: Date.now() - startedAt,
      errorCode: "key_error",
      errorMessage: msg,
    });
    return json({ ok: false, error: { code: "key_error", message: msg }, correlationId }, { status: 200 });
  }

  const startPath = (claimed.next_path as string | null) ?? null;
  const chunk = await computeProfileSnapshotChunk({
    apiKey,
    revision: KLAVIYO_REVISION,
    since90Iso: String(claimed.since90_iso),
    startPath,
    totalProfiles: Number(claimed.total_profiles ?? 0),
    subscribed: Number(claimed.subscribed ?? 0),
    smsSubscribed: Number(claimed.sms_subscribed ?? 0),
    active90d: Number(claimed.active90d ?? 0),
    suppressed: Number(claimed.suppressed ?? 0),
    deadlineAtMs,
  });

  if (!chunk.ok) {
    // 429s and 5xx are Klaviyo having a moment, not the scan being wrong. With
    // a cursor in hand the job parks as pending and the watchdog resumes it in
    // a few minutes; hours of paging survive a bad minute. Failed is reserved
    // for errors a retry cannot change.
    // A 403 whose body is a Cloudflare HTML page is the CDN edge blocking one
    // request, not a revoked key: Betsey's scan died this way at 183k profiles
    // with a valid cursor in hand, and a manual un-fail resumed it cleanly. A
    // real permissions 403 comes back as Klaviyo JSON, so that still fails.
    const bodyText = typeof chunk.body === "string" ? chunk.body : "";
    const edgeBlock403 = Number(chunk.status) === 403 &&
      /<!DOCTYPE html|cloudflare|attention required/i.test(bodyText);
    const retryable = [429, 500, 502, 503, 504].includes(Number(chunk.status)) || edgeBlock403;
    if (retryable) {
      // NEVER discard the cursor. An earlier version restarted the scan from
      // zero after 12 consecutive blocked resumes, on the theory that the cursor
      // was poisoned. On the account that motivated it, that turned "stuck at
      // 190k" into an endless sawtooth: scan ~20 minutes, get blocked, park ~50
      // minutes, restart from 0, repeat, never finishing. Progress is expensive
      // and the block is temporary, so we keep next_path and simply wait longer
      // between attempts. resume_attempts is the consecutive-block count (reset
      // by any successful chunk) and drives that wait.
      const stalls = Number(claimed.resume_attempts ?? 0) + 1;

      // Waiting forever is its own failure. One account blocks at the same
      // cursor depth on every attempt regardless of pacing, so after this many
      // consecutive blocks the honest move is to publish the counts we DO have
      // as lower bounds and let the report render, rather than leaving four
      // cards reading "full profile scan in progress" indefinitely. next_path
      // is kept, so the scan can still be resumed later.
      // Counts come from the job row (the last progress the scan persisted):
      // this is the failure branch, so `chunk` carries only status and body.
      const PARTIAL_AFTER_BLOCKS = 9;
      const soFar = {
        total: Number(claimed.total_profiles ?? 0),
        subscribed: Number(claimed.subscribed ?? 0),
        sms: Number(claimed.sms_subscribed ?? 0),
        active90d: Number(claimed.active90d ?? 0),
        suppressed: Number(claimed.suppressed ?? 0),
      };
      if (stalls >= PARTIAL_AFTER_BLOCKS && soFar.total > 0) {
        await finalizeProfileScan(
          sb,
          auditId,
          soFar.total,
          soFar.subscribed,
          soFar.sms,
          soFar.active90d,
          soFar.suppressed,
          typeof claimed.staged_revenue_per_recipient === "number"
            ? claimed.staged_revenue_per_recipient
            : null,
          true,
        );
        await logStageRun(sb, {
          correlationId,
          auditId,
          clientId: (claimed.client_id as string) ?? null,
          stage: "resume_profile_scan",
          status: "partial",
          revision: String(claimed.revision ?? KLAVIYO_REVISION),
          elapsedMs: Date.now() - startedAt,
          errorCode: "profile_partial_published",
          errorMessage: `blocked ${stalls}x at ${soFar.total} profiles; published as lower bounds`,
        });
        return json({
          ok: true,
          correlationId,
          profile_metrics_status: "partial",
          total_profiles: soFar.total,
        }, { status: 200 });
      }

      // Escape the poisoned cursor. Recover the scan's position from the cursor
      // Klaviyo just refused and rebuild a FRESH shallow keyset path from it, so
      // the next resume is a brand-new depth-1 query instead of a replay of the
      // request that failed. After a couple of exact re-anchors the window nudges
      // forward to step over a record Klaviyo cannot serve at all.
      const blockedAnchor = anchorFromCursorPath(String(claimed.next_path ?? ""));
      const nudgeMs = anchorNudgeMs(stalls);
      const rebuiltPath = blockedAnchor
        ? profileKeysetPath(new Date(Date.parse(blockedAnchor) + nudgeMs).toISOString())
        : null;
      await sb.from("klaviyo_profile_scan_jobs").update({
        status: "pending",
        resume_attempts: stalls,
        // Only replace the cursor when a position was actually recovered;
        // otherwise keep what we had rather than losing the scan's place.
        ...(rebuiltPath ? { next_path: rebuiltPath } : {}),
        error_message: `transient ${chunk.status} (block #${stalls})${
          rebuiltPath ? `, re-anchored at ${blockedAnchor}${nudgeMs ? ` +${nudgeMs / 60_000}m` : ""}` : ", cursor kept"
        }: ${(trimBody(chunk.body) ?? "").slice(0, 200)}`,
        updated_at: new Date().toISOString(),
      }).eq("audit_id", auditId);
      await logStageRun(sb, {
        correlationId,
        auditId,
        clientId: (claimed.client_id as string) ?? null,
        stage: "resume_profile_scan",
        status: "partial",
        revision: String(claimed.revision ?? KLAVIYO_REVISION),
        elapsedMs: Date.now() - startedAt,
        errorCode: `profile_${chunk.status}_parked`,
        errorMessage: "transient upstream error; watchdog will resume",
      });
      return json({ ok: true, correlationId, profile_metrics_status: "in_progress", reason: "parked_transient" }, { status: 200 });
    }
    await sb.from("klaviyo_profile_scan_jobs").update({
      status: "failed",
      error_message: trimBody(chunk.body) ?? "Klaviyo profile fetch failed",
      updated_at: new Date().toISOString(),
    }).eq("audit_id", auditId);
    await logStageRun(sb, {
      correlationId,
      auditId,
      clientId: (claimed.client_id as string) ?? null,
      stage: "resume_profile_scan",
      status: "error",
      revision: String(claimed.revision ?? KLAVIYO_REVISION),
      elapsedMs: Date.now() - startedAt,
      errorCode: `profile_${chunk.status}`,
      errorMessage: trimBody(chunk.body) ?? "profile fetch failed",
    });
    return json({ ok: false, correlationId, profile_metrics_status: "failed", error: "profile_fetch_failed" }, { status: 200 });
  }

  if (chunk.truncated && chunk.nextPath) {
    await mustSucceed("profile job progress", sb.from("klaviyo_profile_scan_jobs").update({
      status: "pending",
      // Forward progress: the consecutive-park counter starts over.
      resume_attempts: 0,
      next_path: chunk.nextPath,
      total_profiles: chunk.totalProfiles,
      subscribed: chunk.subscribed,
      sms_subscribed: chunk.smsSubscribed,
      active90d: chunk.active90d,
      suppressed: chunk.suppressed,
      updated_at: new Date().toISOString(),
    }).eq("audit_id", auditId));
    await chainStage("resume_profile_scan", auditId);
    await logStageRun(sb, {
      correlationId,
      auditId,
      clientId: (claimed.client_id as string) ?? null,
      stage: "resume_profile_scan",
      status: "partial",
      revision: String(claimed.revision ?? KLAVIYO_REVISION),
      elapsedMs: Date.now() - startedAt,
      errorMessage: `chunk_ok total=${chunk.totalProfiles} subscribed=${chunk.subscribed}`,
    });
    return json({ ok: true, correlationId, profile_metrics_status: "in_progress" });
  }

  const staged = claimed.staged_revenue_per_recipient;
  const stagedRpr = staged != null && Number.isFinite(Number(staged)) ? Number(staged) : null;
  await finalizeProfileScan(sb, auditId, chunk.totalProfiles, chunk.subscribed, chunk.smsSubscribed, chunk.active90d, chunk.suppressed, stagedRpr);
  await logStageRun(sb, {
    correlationId,
    auditId,
    clientId: (claimed.client_id as string) ?? null,
    stage: "resume_profile_scan",
    status: "success",
    revision: String(claimed.revision ?? KLAVIYO_REVISION),
    elapsedMs: Date.now() - startedAt,
    errorMessage: `final total=${chunk.totalProfiles} subscribed=${chunk.subscribed}`,
  });
  return json({ ok: true, correlationId, profile_metrics_status: "complete" });
}

// ---------------------------------------------------------------------------
// Reporting (values reports) + rate limiting
// ---------------------------------------------------------------------------

/**
 * Simple token bucket with both burst and per-minute steady caps. Klaviyo's
 * Query Campaign/Flow Values are documented at 1/s burst + 2/min steady, so
 * running these POSTs through a shared bucket avoids bursts of 429s that each
 * carry 30-60s Retry-After waits.
 */
function createReportingBucket(opts: { tokensPerMin: number; burst: number }) {
  let tokens = opts.burst;
  let lastRefill = Date.now();
  const refillIntervalMs = 60_000 / opts.tokensPerMin;
  async function take() {
    for (;;) {
      const now = Date.now();
      const elapsed = now - lastRefill;
      const refill = Math.floor(elapsed / refillIntervalMs);
      if (refill > 0) {
        tokens = Math.min(opts.burst + opts.tokensPerMin - 1, tokens + refill);
        lastRefill += refill * refillIntervalMs;
      }
      if (tokens > 0) {
        tokens -= 1;
        return;
      }
      const waitMs = refillIntervalMs - (now - lastRefill);
      await sleep(Math.max(50, Math.min(refillIntervalMs, waitMs)));
    }
  }
  return { take };
}

async function queryValuesReport(params: {
  apiKey: string;
  revision: string;
  endpointPath: "/api/campaign-values-reports/" | "/api/flow-values-reports/";
  timeframeKey: "last_30_days" | "last_90_days";
  conversionMetricId: string;
  filter?: string;
  statistics: string[];
  groupBy: string[];
}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), KLAVIYO_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${KLAVIYO_BASE}${params.endpointPath}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Klaviyo-API-Key ${params.apiKey}`,
        revision: params.revision,
      },
      body: JSON.stringify({
        data: {
          type: params.endpointPath.includes("campaign") ? "campaign-values-report" : "flow-values-report",
          attributes: {
            timeframe: { key: params.timeframeKey },
            conversion_metric_id: params.conversionMetricId,
            filter: params.filter,
            statistics: params.statistics,
            group_by: params.groupBy,
          },
        },
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const retryAfterMs = retryAfterMsFromHttpHeaders(res.headers);
    return { ok: res.ok, status: res.status, body, retryAfterMs };
  } catch (e) {
    const aborted = (e as any)?.name === "AbortError";
    return {
      ok: false,
      status: aborted ? 504 : 0,
      body: aborted ? `Reporting request timed out after ${KLAVIYO_HTTP_TIMEOUT_MS}ms` : String(e),
      retryAfterMs: null as number | null,
    };
  } finally {
    clearTimeout(t);
  }
}

function retryAfterMsFromHttpHeaders(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const sec = Number(raw.trim());
  if (!Number.isFinite(sec) || sec < 0) return null;
  return Math.min(120_000, Math.max(1_000, sec * 1000));
}

function retryAfterMsFromKlaviyo429(body: any): number | null {
  try {
    const detail = body?.errors?.[0]?.detail;
    if (typeof detail !== "string") return null;
    const m = detail.match(/expected available in\s+(\d+)\s+seconds/i);
    if (!m?.[1]) return null;
    const seconds = Number(m[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.min(90_000, Math.max(1_000, seconds * 1000));
  } catch {
    return null;
  }
}

type ValuesReportResult = Awaited<ReturnType<typeof queryValuesReport>>;

async function queryMetricAggregateSumValue(params: {
  apiKey: string;
  revision: string;
  metricId: string;
  timezone?: string | null;
  days?: number;
}) {
  const days = params.days ?? 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const filter = [
    `greater-or-equal(datetime,${since.toISOString()})`,
    `less-than(datetime,${new Date().toISOString()})`,
  ];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), KLAVIYO_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`${KLAVIYO_BASE}/api/metric-aggregates/`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Klaviyo-API-Key ${params.apiKey}`,
        revision: params.revision,
      },
      body: JSON.stringify({
        data: {
          type: "metric-aggregate",
          attributes: {
            metric_id: params.metricId,
            measurements: ["sum_value"],
            interval: "day",
            filter,
            timezone: params.timezone ?? "UTC",
          },
        },
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      return { ok: false as const, status: res.status, sum: null as number | null, body };
    }
    const dataPoints = body?.data?.attributes?.data ?? [];
    let sum = 0;
    for (const point of dataPoints) {
      const measurements = point?.measurements?.sum_value;
      if (Array.isArray(measurements)) {
        for (const v of measurements) sum += Number(v) || 0;
      } else if (measurements != null) {
        sum += Number(measurements) || 0;
      }
    }
    return { ok: true as const, status: res.status, sum, body };
  } catch (e) {
    const aborted = (e as any)?.name === "AbortError";
    return {
      ok: false as const,
      status: aborted ? 504 : 0,
      sum: null as number | null,
      body: aborted ? `Metric aggregate timed out after ${KLAVIYO_HTTP_TIMEOUT_MS}ms` : String(e),
    };
  } finally {
    clearTimeout(t);
  }
}

async function queryMetricAggregateSumValueWithRetry(params: Parameters<typeof queryMetricAggregateSumValue>[0]) {
  let last: Awaited<ReturnType<typeof queryMetricAggregateSumValue>> = {
    ok: false,
    status: 0,
    sum: null,
    body: null,
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await queryMetricAggregateSumValue(params);
    if (last.ok) return last;
    if (![429, 500, 502, 503, 504].includes(last.status)) return last;
    await sleep(400 * Math.pow(2, attempt - 1));
  }
  return last;
}

async function queryValuesReportWithBackoff(
  params: Parameters<typeof queryValuesReport>[0] & {
    deadlineAtMs?: number;
    bucket?: { take: () => Promise<void> };
  },
) {
  // Values reports throttle often; retry 429s with server-suggested or exponential waits (never cap at 4s).
  const maxAttempts = 5;
  let last: ValuesReportResult = {
    ok: false,
    status: 0,
    body: null,
    retryAfterMs: null,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (params.bucket) await params.bucket.take();
    last = await queryValuesReport(params);
    if (last.ok) return last;
    if (last.status !== 429) return last;
    if (attempt === maxAttempts) return last;

    const fromBody = retryAfterMsFromKlaviyo429(last.body);
    const fromHeader = last.retryAfterMs;
    const exponential = Math.min(90_000, 1_200 * Math.pow(2, attempt - 1));
    const retryMs = Math.min(90_000, Math.max(1_200, fromBody ?? fromHeader ?? exponential));

    if (params.deadlineAtMs) {
      const slack = params.deadlineAtMs - Date.now() - 2_000;
      if (slack < 800) return last;
      await sleep(Math.min(retryMs, slack));
    } else {
      await sleep(retryMs);
    }
  }
  return last;
}

async function pickBestConversionMetricId(params: {
  apiKey: string;
  revision: string;
  candidateMetricIds: string[];
  flowIds: string[];
  deadlineAtMs?: number;
  bucket?: { take: () => Promise<void> };
}) {
  const candidates = Array.from(new Set(params.candidateMetricIds.filter(Boolean)));
  const timeBudgetMs = params.deadlineAtMs ? params.deadlineAtMs - Date.now() : 30_000;
  // Hard cap: 15s max for probing to leave room for actual reporting queries.
  const probeDeadline = Date.now() + Math.min(timeBudgetMs * 0.15, 15_000);
  let probesRun = 0;

  const sampleFlowIds = params.flowIds.slice(0, 10);
  const flowFilter = sampleFlowIds.length
    ? `contains-any(flow_id,[${sampleFlowIds.map((id) => JSON.stringify(id)).join(",")}])`
    : undefined;

  function hasNonZeroConversion(rows: any[]): boolean {
    return rows.some((r: any) => {
      const stats = r?.statistics ?? {};
      return Number(stats.conversion_value ?? 0) > 0 || Number(stats.conversion_uniques ?? 0) > 0;
    });
  }

  // A metric whose probe 400'd as values-incapable must never be the fallback:
  // that is exactly how a broken "Placed Order" metric ended up running (and
  // zeroing) an entire audit's reporting. A metric that answered OK with zero
  // conversions is at least QUERYABLE, so prefer it over unprobed candidates.
  const notQueryable = new Set<string>();
  let firstQueryable: string | null = null;

  const pass1Count = Math.min(candidates.length, 4);
  for (let i = 0; i < pass1Count; i++) {
    if (Date.now() >= probeDeadline) break;
    const metricId = candidates[i];
    probesRun++;
    const probe = await fetchWithRetry(
      () =>
        queryValuesReportWithBackoff({
          apiKey: params.apiKey,
          revision: params.revision,
          endpointPath: "/api/flow-values-reports/",
          timeframeKey: "last_30_days",
          conversionMetricId: metricId,
          filter: flowFilter,
          statistics: ["recipients", "conversion_value"],
          groupBy: ["flow_id"],
          deadlineAtMs: probeDeadline,
          bucket: params.bucket,
        }),
      1,
    );
    if (!probe.ok) {
      if (isMetricNotValuesQueryable(probe)) notQueryable.add(metricId);
      continue;
    }
    if (firstQueryable === null) firstQueryable = metricId;
    if (hasNonZeroConversion(probe.body?.data?.attributes?.results ?? [])) {
      return { metricId, reason: "probe_flow_filtered" as const, probesRun };
    }
  }

  for (let i = 0; i < Math.min(candidates.length, 2); i++) {
    if (Date.now() >= probeDeadline) break;
    const metricId = candidates[i];
    if (notQueryable.has(metricId)) continue;
    probesRun++;
    const probe = await fetchWithRetry(
      () =>
        queryValuesReportWithBackoff({
          apiKey: params.apiKey,
          revision: params.revision,
          endpointPath: "/api/campaign-values-reports/",
          timeframeKey: "last_30_days",
          conversionMetricId: metricId,
          filter: "contains-any(send_channel,[\"email\"])",
          statistics: ["recipients", "conversion_value"],
          groupBy: ["send_channel"],
          deadlineAtMs: probeDeadline,
          bucket: params.bucket,
        }),
      1,
    );
    if (!probe.ok) {
      if (isMetricNotValuesQueryable(probe)) notQueryable.add(metricId);
      continue;
    }
    if (firstQueryable === null) firstQueryable = metricId;
    if (hasNonZeroConversion(probe.body?.data?.attributes?.results ?? [])) {
      return { metricId, reason: "probe_campaign" as const, probesRun };
    }
  }

  const fallback = firstQueryable ?? candidates.find((id) => !notQueryable.has(id)) ?? null;
  return { metricId: fallback, reason: "fallback_first_candidate" as const, probesRun };
}

/** Klaviyo's 400 for a metric that exists but cannot answer values-report
 * queries (no monetary value attached). Betsey's account has a metric literally
 * named "Placed Order" with this property: the name-based picker chose it
 * directly, and every reporting query on the audit then 400'd with this, so
 * the report rendered $0 revenue and raw error JSON in the metric cards. */
function isMetricNotValuesQueryable(res: { ok: boolean; status?: number | null; body?: unknown }): boolean {
  if (res.ok || res.status !== 400) return false;
  try {
    return JSON.stringify(res.body ?? "").includes("does not support querying for values data");
  } catch {
    return false;
  }
}

/** Find a metric that provably carries revenue values, excluding known-bad
 * ids. Used by the reporting stage to self-heal when the cached metric turns
 * out to be values-incapable, so re-running the stage fixes the audit instead
 * of failing the same way.
 *
 * Probes via metric-aggregates (sum of value), NOT via values reports: the
 * values-report endpoint sits behind the shared 2-per-minute token bucket, and
 * a first version that probed through it blew the stage's 150s wall clock
 * before finishing a single repick. Aggregates answer the same question (does
 * this metric have $value data) in seconds. Prefers a metric with real revenue
 * in the window; falls back to any metric that answers with a value at all. */
async function repickValuesQueryableMetric(params: {
  apiKey: string;
  revision: string;
  excludeIds: string[];
  timezone: string;
  deadlineAtMs: number;
}): Promise<{ id: string; name: string | null } | null> {
  const metricsRes = await klaviyoPaged(
    params.apiKey,
    params.revision,
    "/api/metrics/?fields%5Bmetric%5D=name,integration",
    METRICS_MAX_PAGES,
  );
  if (!metricsRes.ok) return null;
  const { candidates, findName } = pickMetricCandidatesFromList(metricsRes.items ?? []);
  const excluded = new Set(params.excludeIds);
  const eligible = candidates.filter((id) => !excluded.has(id));
  let firstAnswering: string | null = null;
  for (const id of eligible.slice(0, 6)) {
    if (Date.now() >= params.deadlineAtMs - 15_000) break;
    const agg = await queryMetricAggregateSumValueWithRetry({
      apiKey: params.apiKey,
      revision: params.revision,
      metricId: id,
      timezone: params.timezone,
      days: 30,
    });
    if (!agg.ok || agg.sum == null) continue;
    if (agg.sum > 0) return { id, name: findName(id) };
    if (firstAnswering === null) firstAnswering = id;
  }
  return firstAnswering ? { id: firstAnswering, name: findName(firstAnswering) } : null;
}

const REVENUE_METRIC_PATTERNS = [
  "placed order",
  "ordered product",
  "order completed",
  "completed order",
  "checkout completed",
  "fulfilled order",
  "purchase",
];

function pickMetricCandidatesFromList(allMetrics: any[]) {
  const nameOf = (m: any) => (m?.attributes?.name ?? "").toLowerCase();
  const integrationOf = (m: any) => (m?.attributes?.integration?.name ?? m?.attributes?.integration?.category ?? "").toLowerCase();
  const shopifyPlacedOrder = allMetrics.filter((m: any) =>
    nameOf(m).includes("placed order") && (integrationOf(m).includes("shopify") || integrationOf(m).includes("api"))
  ).map((m: any) => m.id);
  const anyPlacedOrder = allMetrics.filter((m: any) => nameOf(m).includes("placed order")).map((m: any) => m.id);
  const otherRevenue = allMetrics.filter((m: any) =>
    REVENUE_METRIC_PATTERNS.some((p) => nameOf(m).includes(p))
  ).map((m: any) => m.id);
  const allIds = allMetrics.map((m: any) => m.id);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const id of [...shopifyPlacedOrder, ...anyPlacedOrder, ...otherRevenue, ...allIds]) {
    if (!seen.has(id)) { seen.add(id); candidates.push(id); }
  }
  const findName = (id: string) => {
    const m = allMetrics.find((x: any) => x.id === id);
    return m?.attributes?.name ?? null;
  };
  return { shopifyPlacedOrder, anyPlacedOrder, candidates, findName };
}

function trimBody(body: unknown, max = 500) {
  if (body == null) return null;
  if (typeof body === "string") return body.slice(0, max);
  try {
    return JSON.stringify(body).slice(0, max);
  } catch {
    return "unserializable";
  }
}

async function mustSucceed(label: string, p: Promise<{ error: any }>) {
  const { error } = await p;
  if (error) throw new Error(`${label} failed: ${error.message ?? "unknown error"}`);
}

async function insertRowsInBatches(
  label: string,
  sb: ReturnType<typeof assertServiceClient>,
  table: string,
  rows: Record<string, unknown>[],
  batchSize = 25,
) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    await mustSucceed(`${label} batch ${batchNum}`, sb.from(table).insert(chunk));
  }
}

function enrichSegmentRaw(segment: any, metricNameMap: Record<string, string>) {
  return { ...segment, _ecd_metric_names: metricNameMap };
}

function enrichCampaignRaw(campaign: any, groupNameMap: Record<string, EcdGroupNameEntry> | null) {
  if (!groupNameMap) return campaign;
  return { ...campaign, _ecd_group_names: groupNameMap };
}

// ---------------------------------------------------------------------------
// klaviyo_runs logging (stage-aware)
// ---------------------------------------------------------------------------

async function logStageRun(
  sb: ReturnType<typeof assertServiceClient>,
  row: {
    correlationId: string;
    auditId: string | null;
    clientId: string | null;
    stage: Stage;
    status: "success" | "error" | "partial" | "timeout";
    revision: string | null;
    elapsedMs: number;
    errorCode?: string;
    errorMessage?: string | null;
  },
) {
  try {
    await sb.from("klaviyo_runs").insert({
      correlation_id: row.correlationId,
      audit_id: row.auditId,
      client_id: row.clientId,
      stage: row.stage,
      status: row.status,
      revision: row.revision,
      elapsed_ms: row.elapsedMs,
      error_code: row.errorCode ?? null,
      error_message: row.errorMessage ? row.errorMessage.slice(0, 1000) : null,
    });
  } catch { /* swallow */ }
}

// ---------------------------------------------------------------------------
// Shared: resolve API key for a client
// ---------------------------------------------------------------------------

async function resolveApiKey(
  sb: ReturnType<typeof assertServiceClient>,
  clientId: string,
  inlineKey: string | null | undefined,
): Promise<string> {
  const inline = (inlineKey ?? "").trim();
  if (inline) {
    const enc = await encryptString(inline);
    await mustSucceed("client_secrets upsert", sb.from("client_secrets").upsert({
      client_id: clientId,
      klaviyo_private_key_ciphertext: enc.ciphertext,
      klaviyo_private_key_iv: enc.iv,
      klaviyo_private_key_alg: enc.alg,
      updated_at: new Date().toISOString(),
    }, { onConflict: "client_id" }));
    return inline;
  }
  const { data, error } = await sb.from("client_secrets").select("*").eq("client_id", clientId).maybeSingle();
  if (error) throw error;
  if (!data?.klaviyo_private_key_ciphertext || !data?.klaviyo_private_key_iv) {
    throw new Error("No Klaviyo key stored for this client");
  }
  return await decryptString(data.klaviyo_private_key_ciphertext, data.klaviyo_private_key_iv);
}

// ---------------------------------------------------------------------------
// Campaign email HTML (email design comparison)
// ---------------------------------------------------------------------------

async function fetchCampaignEmailHtml(
  apiKey: string,
  revision: string,
  campaignId: string,
): Promise<string | null> {
  const msgRes = await fetchWithRetry(
    () => klaviyoFetch(apiKey, revision, `/api/campaigns/${campaignId}/campaign-messages/`),
    3,
  );
  const messages = msgRes.ok ? (msgRes.body?.data ?? []) : [];
  for (const msg of messages) {
    const htmlBody = msg?.attributes?.content?.html;
    if (htmlBody) return htmlBody;
    const templateId = msg?.relationships?.template?.data?.id;
    if (templateId) {
      const tplRes = await fetchWithRetry(
        () => klaviyoFetch(apiKey, revision, `/api/templates/${templateId}/`),
        3,
      );
      if (tplRes.ok && tplRes.body?.data?.attributes?.html) {
        return tplRes.body.data.attributes.html;
      }
    }
  }
  return null;
}

async function runStageFetchCampaignEmail(params: {
  auditId: string;
  campaignId: string;
  persist: boolean;
  correlationId: string;
}): Promise<Response> {
  const sb = assertServiceClient();

  const { data: audit, error: auditErr } = await sb
    .from("audits")
    .select("client_id")
    .eq("id", params.auditId)
    .maybeSingle();
  if (auditErr) throw auditErr;
  if (!audit?.client_id) {
    return json({
      ok: false,
      error: { code: "not_found", message: "Audit not found" },
      correlationId: params.correlationId,
    }, { status: 404 });
  }
  const clientId = audit.client_id as string;

  const { data: snap } = await sb
    .from("klaviyo_campaign_snapshots")
    .select("name, campaign_id")
    .eq("audit_id", params.auditId)
    .eq("campaign_id", params.campaignId)
    .maybeSingle();

  const { data: conn } = await sb
    .from("klaviyo_connections")
    .select("revision")
    .eq("client_id", clientId)
    .maybeSingle();
  const revision = KLAVIYO_REVISION;

  const apiKey = await resolveApiKey(sb, clientId, null);
  const html = await fetchCampaignEmailHtml(apiKey, revision, params.campaignId);

  if (!html) {
    return json({
      ok: false,
      error: {
        code: "no_html",
        message: "No email HTML found for this campaign (inline content and template were empty).",
      },
      correlationId: params.correlationId,
      campaign_id: params.campaignId,
    }, { status: 200 });
  }

  let campaignName = (snap?.name as string | null) ?? null;
  if (!campaignName) {
    const campRes = await fetchWithRetry(
      () => klaviyoFetch(apiKey, revision, `/api/campaigns/${params.campaignId}/`),
      3,
    );
    if (campRes.ok && campRes.body?.data?.attributes?.name) {
      campaignName = campRes.body.data.attributes.name;
    }
  }

  if (params.persist) {
    await sb.from("audit_email_design").upsert({
      audit_id: params.auditId,
      client_email_html: html,
      client_campaign_name: campaignName,
      client_campaign_id: params.campaignId,
    }, { onConflict: "audit_id" }).select();
  }

  return json({
    ok: true,
    correlationId: params.correlationId,
    stage: "fetch_campaign_email",
    html,
    campaign_id: params.campaignId,
    name: campaignName,
    persisted: params.persist,
  });
}

// ---------------------------------------------------------------------------
// Stage 1: config
// ---------------------------------------------------------------------------

async function runStageConfig(params: {
  auditId: string;
  clientId: string;
  apiKeyInline: string | null;
  revision: string;
  profileScan: "full" | "fast";
  correlationId: string;
}): Promise<Response> {
  const startedAt = Date.now();
  const deadlineAtMs = startedAt + 148_000;
  const sb = assertServiceClient();

  try {
    const apiKey = await resolveApiKey(sb, params.clientId, params.apiKeyInline);

    // Account + config fetches.
    const accountRes = await fetchWithRetry(() => klaviyoFetch(apiKey, params.revision, "/api/accounts/"), 3);
    if (!accountRes.ok) {
      const detail =
        (accountRes.body as any)?.errors?.[0]?.detail ??
        (accountRes.body as any)?.error?.message ??
        null;
      await logStageRun(sb, {
        correlationId: params.correlationId,
        auditId: params.auditId,
        clientId: params.clientId,
        stage: "config",
        status: "error",
        revision: params.revision,
        elapsedMs: Date.now() - startedAt,
        errorCode: "invalid_key_or_scope",
        errorMessage: `Account lookup failed (${accountRes.status})${detail ? `: ${detail}` : ""}`,
      });
      return json({
        ok: false,
        error: {
          code: "invalid_key_or_scope",
          status: accountRes.status,
          message: `Account lookup failed (${accountRes.status})${detail ? `: ${detail}` : ""}`,
        },
        correlationId: params.correlationId,
      }, { status: 200 });
    }
    const account = accountRes.body?.data?.[0] ?? null;
    const accountId = account?.id ?? null;
    const accountName = account?.attributes?.contact_information?.organization_name ?? null;
    const websiteUrl = account?.attributes?.contact_information?.website_url ?? null;
    const timezone = account?.attributes?.timezone ?? null;
    const preferredCurrency = account?.attributes?.preferred_currency ?? null;

    const [flows, lists, segmentNames, segments, forms, campaigns, metricsRes] = await Promise.all([
      klaviyoPaged(apiKey, params.revision, "/api/flows/?page%5Bsize%5D=50"),
      klaviyoPaged(apiKey, params.revision, "/api/lists/", MAX_LIST_PAGES),
      klaviyoPaged(apiKey, params.revision, SEGMENTS_NAMES_ONLY_PATH, MAX_SEGMENT_NAME_PAGES),
      klaviyoPaged(apiKey, params.revision, SEGMENTS_WITH_DEFINITIONS_PATH, MAX_SEGMENT_DEFINITION_PAGES),
      klaviyoPaged(apiKey, params.revision, "/api/forms/?page%5Bsize%5D=100"),
      klaviyoPaged(apiKey, params.revision, CAMPAIGNS_WITH_AUDIENCES_PATH, MAX_CAMPAIGN_PAGES),
      klaviyoPaged(apiKey, params.revision, "/api/metrics/?fields%5Bmetric%5D=name,integration", METRICS_MAX_PAGES),
    ]);

    const metricNameMap = Object.fromEntries(
      (metricsRes.ok ? metricsRes.items : []).map((m: any) => [m.id, m.attributes?.name ?? m.id]),
    );
    let groupNameMap = buildGroupNameMap(
      lists.ok ? lists.items : [],
      [
        ...(segmentNames.ok ? segmentNames.items : []),
        ...(segments.ok ? segments.items : []),
      ],
    );
    const campaignItemsForHydrate = campaigns.ok ? campaigns.items.slice(0, CAMPAIGN_SNAPSHOT_CAP) : [];
    const hydrated = await hydrateAudienceIds({
      apiKey,
      revision: params.revision,
      groupNameMap,
      campaigns: campaignItemsForHydrate,
    });
    groupNameMap = hydrated.groupNameMap;
    const segmentItemsForSnapshots = mergeSegmentItemsForSnapshots(
      segments.ok ? segments.items : [],
      hydrated.hydratedSegments,
    );

    // Clear prior snapshots for this audit.
    await mustSucceed("delete klaviyo_flow_snapshots", sb.from("klaviyo_flow_snapshots").delete().eq("audit_id", params.auditId));
    await mustSucceed("delete klaviyo_campaign_snapshots", sb.from("klaviyo_campaign_snapshots").delete().eq("audit_id", params.auditId));
    await mustSucceed("delete klaviyo_form_snapshots", sb.from("klaviyo_form_snapshots").delete().eq("audit_id", params.auditId));
    await mustSucceed("delete klaviyo_segment_snapshots", sb.from("klaviyo_segment_snapshots").delete().eq("audit_id", params.auditId));
    await mustSucceed("delete klaviyo_reporting_rollups", sb.from("klaviyo_reporting_rollups").delete().eq("audit_id", params.auditId));

    if (flows.ok) {
      const rows = flows.items.map((f: any) => ({
        audit_id: params.auditId,
        client_id: params.clientId,
        flow_id: f.id,
        name: f.attributes?.name ?? "",
        status: f.attributes?.status ?? "",
        trigger_type: f.attributes?.trigger_type ?? null,
        archived: f.attributes?.archived ?? null,
        created_at_klaviyo: f.attributes?.created ? new Date(f.attributes.created).toISOString() : null,
        updated_at_klaviyo: f.attributes?.updated ? new Date(f.attributes.updated).toISOString() : null,
        raw: f,
      }));
      if (rows.length) await insertRowsInBatches("insert klaviyo_flow_snapshots", sb, "klaviyo_flow_snapshots", rows);
    }

    if (campaigns.ok) {
      const campaignItems = campaignItemsForHydrate;
      const rows = campaignItems.map((c: any, index: number) => ({
        audit_id: params.auditId,
        client_id: params.clientId,
        campaign_id: c.id,
        name: c.attributes?.name ?? "",
        status: c.attributes?.status ?? "",
        send_channel: c.attributes?.send_channel ?? "email",
        created_at_klaviyo: c.attributes?.created_at ?? null,
        updated_at_klaviyo: c.attributes?.updated_at ?? null,
        raw: enrichCampaignRaw(c, index === 0 ? groupNameMap : null),
      }));
      if (rows.length) await insertRowsInBatches("insert klaviyo_campaign_snapshots", sb, "klaviyo_campaign_snapshots", rows);

      // Best-effort: grab HTML of most recent sent campaign for email-design comparison.
      try {
        if (deadlineAtMs - Date.now() >= MIN_SLACK_MS_EMAIL_HTML) {
          const sentCampaigns = campaignItems
            .filter((c: any) => (c.attributes?.status ?? "").toLowerCase() === "sent")
            .sort((a: any, b: any) => {
              const da = a.attributes?.updated_at || a.attributes?.created_at || "";
              const db = b.attributes?.updated_at || b.attributes?.created_at || "";
              return db.localeCompare(da);
            });
          const recentCampaign = sentCampaigns[0];
          if (recentCampaign) {
            const emailHtml = await fetchCampaignEmailHtml(apiKey, params.revision, recentCampaign.id);
            if (emailHtml) {
              await sb.from("audit_email_design").upsert({
                audit_id: params.auditId,
                client_email_html: emailHtml,
                client_campaign_name: recentCampaign.attributes?.name ?? null,
                client_campaign_id: recentCampaign.id,
              }, { onConflict: "audit_id" }).select();
            }
          }
        }
      } catch { /* non-critical */ }
    }

    if (forms.ok) {
      const rows = forms.items.map((f: any) => ({
        audit_id: params.auditId,
        client_id: params.clientId,
        form_id: f.id,
        name: f.attributes?.name ?? "",
        status: f.attributes?.status ?? "",
        ab_test: f.attributes?.ab_test ?? null,
        created_at_klaviyo: f.attributes?.created_at ?? null,
        updated_at_klaviyo: f.attributes?.updated_at ?? null,
        raw: f,
      }));
      if (rows.length) await insertRowsInBatches("insert klaviyo_form_snapshots", sb, "klaviyo_form_snapshots", rows);
    }

    if (segments.ok || segmentItemsForSnapshots.length > 0) {
      const rows = segmentItemsForSnapshots.map((s: any) => ({
        audit_id: params.auditId,
        client_id: params.clientId,
        segment_id: s.id,
        name: s.attributes?.name ?? "",
        created_at_klaviyo: s.attributes?.created ?? null,
        updated_at_klaviyo: s.attributes?.updated ?? null,
        raw: enrichSegmentRaw(s, metricNameMap),
      }));
      if (rows.length) await insertRowsInBatches("insert klaviyo_segment_snapshots", sb, "klaviyo_segment_snapshots", rows);
    }

    // Diagnostic summary + connection metadata.
    function extractKlaviyoError(res: any): string | null {
      if (res.ok) return null;
      const errs = res.body?.errors;
      if (Array.isArray(errs) && errs.length > 0) {
        return errs.map((e: any) => `${e.status ?? ""} ${e.title ?? ""}: ${e.detail ?? ""}`).join("; ").slice(0, 500);
      }
      if (typeof res.body === "string") return res.body.slice(0, 500);
      try { return JSON.stringify(res.body).slice(0, 500); } catch { return "unknown"; }
    }
    const resources = { accounts: accountRes, flows, lists, segments, forms, campaigns, metrics: metricsRes } as Record<string, any>;
    const scopeDiag: Record<string, any> = {};
    for (const [name, res] of Object.entries(resources)) {
      scopeDiag[name] = res.ok ? true : { ok: false, status: res.status ?? null, error: extractKlaviyoError(res) };
    }

    await mustSucceed("upsert klaviyo_connections", sb.from("klaviyo_connections").upsert({
      client_id: params.clientId,
      account_id: accountId,
      account_name: accountName,
      website_url: websiteUrl,
      timezone,
      preferred_currency: preferredCurrency,
      revision: params.revision,
      scopes: scopeDiag,
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "client_id" }));

    if (websiteUrl) {
      const { data: existingClient } = await sb.from("clients").select("website_url").eq("id", params.clientId).maybeSingle();
      if (!existingClient?.website_url) {
        await mustSucceed("update clients.website_url", sb.from("clients").update({ website_url: websiteUrl }).eq("id", params.clientId));
      }
    }
    await mustSucceed("update clients.klaviyo_connected", sb.from("clients").update({ klaviyo_connected: true }).eq("id", params.clientId));

    // Resolve conversion metric: prefer cache, then single unambiguous Shopify "Placed Order", else probe.
    const allMetrics = metricsRes.ok ? metricsRes.items : [];
    const { shopifyPlacedOrder, anyPlacedOrder, candidates: metricCandidates, findName } =
      pickMetricCandidatesFromList(allMetrics);

    let conversionMetricId: string | null = null;
    let conversionMetricName: string | null = null;
    let metricPickReason: string = "none";
    let metricProbesRun = 0;

    // Cache read.
    const { data: conn } = await sb.from("klaviyo_connections")
      .select("conversion_metric_id, conversion_metric_name, conversion_metric_verified_at")
      .eq("client_id", params.clientId).maybeSingle();
    const cachedId = (conn?.conversion_metric_id ?? null) as string | null;
    const cachedVerifiedAtMs = conn?.conversion_metric_verified_at ? Date.parse(String(conn.conversion_metric_verified_at)) : NaN;
    const cacheFresh =
      !!cachedId &&
      Number.isFinite(cachedVerifiedAtMs) &&
      (Date.now() - cachedVerifiedAtMs) < METRIC_CACHE_TTL_MS &&
      allMetrics.some((m: any) => m.id === cachedId);
    if (cacheFresh && cachedId) {
      conversionMetricId = cachedId;
      conversionMetricName = (conn?.conversion_metric_name as string | null) ?? findName(cachedId) ?? null;
      metricPickReason = "cache_hit";
    } else if (shopifyPlacedOrder.length === 1) {
      conversionMetricId = shopifyPlacedOrder[0];
      conversionMetricName = findName(conversionMetricId!) ?? null;
      metricPickReason = "shopify_placed_order_direct";
    } else if (anyPlacedOrder.length === 1 && shopifyPlacedOrder.length === 0) {
      conversionMetricId = anyPlacedOrder[0];
      conversionMetricName = findName(conversionMetricId!) ?? null;
      metricPickReason = "placed_order_direct";
    } else if (metricsRes.ok && metricCandidates.length > 0) {
      const bucket = createReportingBucket({ tokensPerMin: REPORTING_TOKENS_PER_MIN, burst: REPORTING_BURST });
      const flowIds = flows.ok ? flows.items.map((f: any) => f.id) : [];
      const picked = await pickBestConversionMetricId({
        apiKey,
        revision: params.revision,
        candidateMetricIds: metricCandidates,
        flowIds,
        deadlineAtMs,
        bucket,
      });
      conversionMetricId = picked.metricId;
      conversionMetricName = conversionMetricId ? (findName(conversionMetricId) ?? null) : null;
      metricPickReason = picked.reason;
      metricProbesRun = picked.probesRun ?? 0;
    } else {
      metricPickReason = "metrics_fetch_failed";
    }

    if (conversionMetricId) {
      await sb.from("klaviyo_connections").update({
        conversion_metric_id: conversionMetricId,
        conversion_metric_name: conversionMetricName,
        conversion_metric_verified_at: new Date().toISOString(),
      }).eq("client_id", params.clientId);
    }

    const campaignsTruncated = campaigns.ok
      ? (campaigns.truncated || campaigns.items.length > CAMPAIGN_SNAPSHOT_CAP)
      : null;

    const since90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    // Seed reporting rollup shell (counts only); stage 2 fills in report data.
    const timeframeKeys: Array<"last_30_days" | "last_90_days"> = ["last_30_days"];
    const accountSnapshotSeed = {
      email_subscribed_profiles_count: null as number | null,
      active_profiles_90d_count: null as number | null,
      suppressed_profiles_count: null as number | null,
      bounce_rate_90d: null as number | null,
      spam_rate_90d: null as number | null,
      deliverability_campaign_timeframe: "last_30_days",
      active_profiles_definition: "Proxy: email-subscribed profiles updated in last 90 days",
      email_subscribed_profiles_truncated: null as boolean | null,
      active_profiles_90d_truncated: null as boolean | null,
      suppressed_profiles_truncated: null as boolean | null,
      campaigns_truncated: campaignsTruncated,
      profile_scan_status: (params.profileScan === "full" ? "pending" : "skipped") as "pending" | "skipped",
      deliverability: null as null,
      computed_at: new Date().toISOString(),
    };
    const derivedMetricsSeed = { list_size: 0, monthly_engagement: 0, revenue_per_recipient: null as number | null };
    for (const tf of timeframeKeys) {
      await mustSucceed("insert klaviyo_reporting_rollups seed", sb.from("klaviyo_reporting_rollups").insert({
        audit_id: params.auditId,
        client_id: params.clientId,
        timeframe_key: tf,
        conversion_metric_id: conversionMetricId,
        campaigns: [],
        flows: [],
        computed: {
          counts: {
            flows: flows.ok ? flows.items.length : null,
            campaigns: campaigns.ok ? campaigns.items.length : null,
            forms: forms.ok ? forms.items.length : null,
            segments: segmentItemsForSnapshots.length || null,
            lists: lists.ok ? lists.items.length : null,
          },
          reporting_errors: [],
          account_snapshot: accountSnapshotSeed,
          derived_metrics: derivedMetricsSeed,
          metric_selection: { reason: metricPickReason, probes_run: metricProbesRun },
          group_name_map: groupNameMap,
          metric_name_map: metricNameMap,
          since90_iso: since90,
          stage: "config_complete",
        },
      }));
    }

    // Chain stage 2 (reporting). Stage 3 (profile) is kicked off by stage 2.
    await chainStage("reporting", params.auditId);

    const failedEndpoints = Object.entries(scopeDiag).filter(([, v]) => v !== true);
    await logStageRun(sb, {
      correlationId: params.correlationId,
      auditId: params.auditId,
      clientId: params.clientId,
      stage: "config",
      status: failedEndpoints.length > 0 ? "partial" : "success",
      revision: params.revision,
      elapsedMs: Date.now() - startedAt,
      errorMessage: failedEndpoints.length > 0 ? JSON.stringify(Object.fromEntries(failedEndpoints)) : null,
    });

    return json({
      ok: true,
      correlationId: params.correlationId,
      stage: "config",
      revision: params.revision,
      account: { id: accountId, name: accountName, timezone, preferredCurrency },
      counts: {
        flows: flows.ok ? flows.items.length : null,
        campaigns: campaigns.ok ? campaigns.items.length : null,
        forms: forms.ok ? forms.items.length : null,
        segments: segmentItemsForSnapshots.length || null,
        lists: lists.ok ? lists.items.length : null,
      },
      fetch: Object.fromEntries(
        Object.entries(resources).map(([name, res]) => [
          name,
          res.ok
            ? { ok: true, status: res.status ?? 200 }
            : { ok: false, status: res.status ?? null, error: extractKlaviyoError(res) },
        ]),
      ),
      reporting: {
        conversion_metric_id: conversionMetricId,
        conversion_metric_name: conversionMetricName,
        conversion_metric_selection: {
          reason: metricPickReason,
          probes_run: metricProbesRun,
          candidates_tested: metricCandidates.slice(0, 10),
        },
        // Stage 2 will fill these in; the frontend should poll klaviyo_runs(stage=reporting).
        campaign_reports: [],
        flow_reports: [],
        errors: [],
        reporting_ok: null,
      },
      account_snapshot: accountSnapshotSeed,
      // Frontend uses this to decide whether to poll klaviyo_profile_scan_jobs.
      // Either way it still polls klaviyo_runs(stage='reporting') for stage 2 completion.
      profile_metrics_status: (params.profileScan === "full" ? "pending" : "complete") as "pending" | "complete",
      derived_metrics: derivedMetricsSeed,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (e) {
    const msg = redactSecrets(e instanceof Error ? e.message : "Unknown error");
    await logStageRun(sb, {
      correlationId: params.correlationId,
      auditId: params.auditId,
      clientId: params.clientId,
      stage: "config",
      status: "error",
      revision: params.revision,
      elapsedMs: Date.now() - startedAt,
      errorCode: "config_failed",
      errorMessage: msg,
    });
    return json({ ok: false, error: { code: "config_failed", message: msg }, correlationId: params.correlationId }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Stage 2: reporting
// ---------------------------------------------------------------------------

async function runStageReporting(params: {
  auditId: string;
  correlationId: string;
}): Promise<Response> {
  const startedAt = Date.now();
  const deadlineAtMs = startedAt + 148_000;
  const sb = assertServiceClient();

  let clientId: string | null = null;
  let revision: string = KLAVIYO_REVISION;
  try {
    const { data: audit, error: auditErr } = await sb.from("audits").select("client_id").eq("id", params.auditId).maybeSingle();
    if (auditErr) throw auditErr;
    if (!audit?.client_id) throw new Error("audit not found");
    clientId = audit.client_id as string;

    const { data: conn } = await sb.from("klaviyo_connections")
      .select("revision, conversion_metric_id, timezone")
      .eq("client_id", clientId).maybeSingle();
    revision = KLAVIYO_REVISION;
    // Mutable: the stage re-picks mid-run when the cached metric turns out to
    // be values-incapable (see the camp30 failure branch below).
    let conversionMetricId = (conn?.conversion_metric_id as string | null) || null;
    const accountTimezone = (conn?.timezone as string | null) || "UTC";

    const apiKey = await resolveApiKey(sb, clientId, null);

    // Reload snapshots + counts from DB (stage 1 persisted them).
    const { data: flowRows } = await sb.from("klaviyo_flow_snapshots")
      .select("flow_id, name, status").eq("audit_id", params.auditId);
    const flowIds = (flowRows ?? []).map((r) => r.flow_id as string);

    const { data: rollups } = await sb.from("klaviyo_reporting_rollups")
      .select("id, timeframe_key, computed").eq("audit_id", params.auditId);
    const timeframeKeys: Array<"last_30_days" | "last_90_days"> = ["last_30_days"];
    const reportingErrors: Array<{ stage: string; status?: number | null; message: string }> = [];

    // Profile-scan mode from stage 1 seed.
    const accountSnapshotSeed = rollups?.[0]?.computed && (rollups[0].computed as any)?.account_snapshot;
    const profileScanFull = (accountSnapshotSeed?.profile_scan_status ?? "skipped") === "pending";
    const since90 = (rollups?.[0]?.computed as any)?.since90_iso
      || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    if (!conversionMetricId) {
      reportingErrors.push({ stage: "metrics_lookup", status: null, message: "No cached conversion_metric_id; run stage=config first." });
    }

    const flowIdsForReport = flowIds.slice(0, MAX_REPORT_IDS);
    const flowFilterForReport = flowIdsForReport.length
      ? `contains-any(flow_id,[${flowIdsForReport.map((id) => JSON.stringify(id)).join(",")}])`
      : undefined;

    const flowReportStats = ["recipients", "open_rate", "click_rate", "conversion_rate", "conversion_value", "revenue_per_recipient"];
    const campaignReportStats = [
      "recipients",
      "open_rate",
      "click_rate",
      "conversion_rate",
      "conversion_value",
      "revenue_per_recipient",
      "bounce_rate",
      "spam_complaint_rate",
      "unsubscribe_rate",
    ];

    const bucket = createReportingBucket({ tokensPerMin: REPORTING_TOKENS_PER_MIN, burst: REPORTING_BURST });
    const campaignReports: Array<{ timeframe: "last_30_days" | "last_90_days"; results: any[] }> = [];
    const flowReports: Array<{ timeframe: "last_30_days" | "last_90_days"; results: any[] }> = [];
    let revenuePerRecipient: number | null = null;
    let bounceRate90d: number | null = null;
    let spamRate90d: number | null = null;
    let metricReCacheAt: string | null = null;
    let totalStoreRevenue: number | null = null;
    let campaignRowsAllChannels: any[] = [];

    await mustSucceed("delete flow_performance", sb.from("flow_performance").delete().eq("audit_id", params.auditId));

    if (conversionMetricId) {
      // Serialize main reports through the token bucket (2/min steady).
      const tf: "last_30_days" = "last_30_days";
      const campaignParams = () => ({
        apiKey,
        revision,
        endpointPath: "/api/campaign-values-reports/" as const,
        timeframeKey: tf,
        conversionMetricId: conversionMetricId as string,
        filter: "contains-any(send_channel,[\"email\"])",
        statistics: campaignReportStats,
        groupBy: ["campaign_id", "campaign_message_id", "send_channel"],
        deadlineAtMs,
        bucket,
      });
      let camp30 = await queryValuesReportWithBackoff(campaignParams());
      // Self-heal a values-incapable metric. The name-based picker can choose a
      // metric Klaviyo then rejects for every values query ("Placed Order" with
      // no monetary value on Betsey's account), which used to zero out the whole
      // report. Re-pick a provably queryable metric, persist it, and continue,
      // so re-running this stage repairs the audit.
      if (!camp30.ok && isMetricNotValuesQueryable(camp30)) {
        const badId = conversionMetricId;
        const repicked = await repickValuesQueryableMetric({
          apiKey,
          revision,
          excludeIds: [badId],
          timezone: accountTimezone,
          deadlineAtMs,
        });
        if (repicked) {
          conversionMetricId = repicked.id;
          await sb.from("klaviyo_connections").update({
            conversion_metric_id: repicked.id,
            conversion_metric_name: repicked.name,
            conversion_metric_verified_at: new Date().toISOString(),
          }).eq("client_id", clientId);
          await sb.from("klaviyo_reporting_rollups").update({ conversion_metric_id: repicked.id })
            .eq("audit_id", params.auditId);
          reportingErrors.push({
            stage: "conversion_metric_repick",
            status: null,
            message:
              `Cached conversion metric ${badId} cannot answer values queries; switched to ${repicked.id} (${repicked.name ?? "unnamed"}) and continued.`,
          });
          camp30 = await queryValuesReportWithBackoff(campaignParams());
        }
      }
      if (camp30.ok) {
        campaignReports.push({ timeframe: tf, results: camp30.body?.data?.attributes?.results ?? [] });
      } else {
        reportingErrors.push({ stage: `campaign_values_${tf}`, status: camp30.status ?? null, message: trimBody(camp30.body) ?? "Campaign values report failed" });
      }

      const flow30 = await queryValuesReportWithBackoff({
        apiKey,
        revision,
        endpointPath: "/api/flow-values-reports/",
        timeframeKey: tf,
        conversionMetricId,
        filter: flowFilterForReport,
        statistics: flowReportStats,
        groupBy: ["flow_id", "flow_message_id", "send_channel"],
        deadlineAtMs,
        bucket,
      });
      if (flow30.ok) {
        flowReports.push({ timeframe: tf, results: flow30.body?.data?.attributes?.results ?? [] });
      } else {
        reportingErrors.push({ stage: `flow_values_${tf}`, status: flow30.status ?? null, message: trimBody(flow30.body) ?? "Flow values report failed" });
      }

      const campAllChannels30 = await queryValuesReportWithBackoff({
        apiKey,
        revision,
        endpointPath: "/api/campaign-values-reports/",
        timeframeKey: tf,
        conversionMetricId,
        statistics: ["conversion_value"],
        groupBy: ["campaign_id", "campaign_message_id", "send_channel"],
        deadlineAtMs,
        bucket,
      });
      if (campAllChannels30.ok) {
        campaignRowsAllChannels = campAllChannels30.body?.data?.attributes?.results ?? [];
      } else {
        reportingErrors.push({
          stage: "campaign_values_all_channels_last_30_days",
          status: campAllChannels30.status ?? null,
          message: trimBody(campAllChannels30.body) ?? "All-channel campaign values report failed",
        });
      }

      const metricAgg = await queryMetricAggregateSumValueWithRetry({
        apiKey,
        revision,
        metricId: conversionMetricId,
        timezone: accountTimezone,
        days: 30,
      });
      if (metricAgg.ok && metricAgg.sum != null) {
        totalStoreRevenue = metricAgg.sum;
      } else {
        reportingErrors.push({
          stage: "metric_aggregate_total_revenue",
          status: metricAgg.status ?? null,
          message: trimBody(metricAgg.body) ?? "Metric aggregate total revenue failed",
        });
      }

      // 90d campaign for deliverability.
      const camp90 = await queryValuesReportWithBackoff({
        apiKey,
        revision,
        endpointPath: "/api/campaign-values-reports/",
        timeframeKey: "last_90_days",
        conversionMetricId,
        filter: "contains-any(send_channel,[\"email\"])",
        statistics: campaignReportStats,
        groupBy: ["campaign_id", "campaign_message_id", "send_channel"],
        deadlineAtMs,
        bucket,
      });
      if (camp90.ok) {
        campaignReports.push({ timeframe: "last_90_days", results: camp90.body?.data?.attributes?.results ?? [] });
      } else {
        reportingErrors.push({ stage: "campaign_values_last_90_days", status: camp90.status ?? null, message: trimBody(camp90.body) ?? "Campaign values report failed (last_90_days)" });
      }

      // Flow rollup into flow_performance.
      const flowAgg: Record<string, { recipients: number; open: number; click: number; conv: number; value: number; rpr: number; messageIds: Set<string> }> = {};
      const last30 = flowReports.find((r) => r.timeframe === "last_30_days")?.results ?? [];
      for (const row of last30) {
        const gid = row?.groupings?.flow_id;
        if (!gid) continue;
        const stats = row?.statistics ?? {};
        const recipients = Number(stats.recipients ?? 0) || 0;
        const open_rate = Number(stats.open_rate ?? 0) || 0;
        const click_rate = Number(stats.click_rate ?? 0) || 0;
        const conv_rate = Number(stats.conversion_rate ?? 0) || 0;
        const value = Number(stats.conversion_value ?? 0) || 0;
        const rpr = Number(stats.revenue_per_recipient ?? 0) || 0;
        if (!flowAgg[gid]) flowAgg[gid] = { recipients: 0, open: 0, click: 0, conv: 0, value: 0, rpr: 0, messageIds: new Set() };
        flowAgg[gid].recipients += recipients;
        flowAgg[gid].open += open_rate * recipients;
        flowAgg[gid].click += click_rate * recipients;
        flowAgg[gid].conv += conv_rate * recipients;
        flowAgg[gid].value += value;
        flowAgg[gid].rpr += rpr * recipients;
        const mid = row?.groupings?.flow_message_id;
        if (mid) flowAgg[gid].messageIds.add(mid);
      }

      const platformBenchmarks = await fetchPlatformBenchmarkConfig(sb);

      const flowPerfRows = Object.entries(flowAgg).map(([flowId, a]) => {
        const denom = Math.max(1, a.recipients);
        const actual_open = a.open / denom;
        const actual_click = a.click / denom;
        const actual_conv = a.conv / denom;
        const actual_rpr = a.rpr / denom;
        const flowMeta = (flowRows ?? []).find((f) => f.flow_id === flowId);
        const flowName = flowMeta?.name ?? flowId;
        const flowStatus = ((flowMeta?.status ?? "live") as string).toLowerCase();
        const mappedStatus =
          flowStatus.includes("draft") ? "draft" : flowStatus.includes("paused") ? "paused" : "live";
        const flowBenchmarks = getFlowBenchmarks(flowName, platformBenchmarks);
        const nonRevenue = flowBenchmarks.tier === "non_revenue";
        const targetRpr = actual_rpr * 1.15;
        const opportunity = nonRevenue ? 0 : Math.max(0, (targetRpr - actual_rpr) * a.recipients);
        return {
          audit_id: params.auditId,
          flow_name: flowName,
          flow_status: mappedStatus,
          priority: "medium",
          recipients_per_month: Math.round(a.recipients),
          actual_open_rate: actual_open,
          benchmark_open_rate_low: flowBenchmarks.openRateLow,
          benchmark_open_rate_high: flowBenchmarks.openRateHigh,
          actual_click_rate: actual_click,
          benchmark_click_rate_low: flowBenchmarks.clickRateLow,
          benchmark_click_rate_high: flowBenchmarks.clickRateHigh,
          actual_conv_rate: actual_conv,
          benchmark_conv_rate_low: flowBenchmarks.convRateLow,
          benchmark_conv_rate_high: flowBenchmarks.convRateHigh,
          monthly_revenue_current: a.value,
          monthly_revenue_opportunity: opportunity,
          email_message_count: a.messageIds.size || null,
          notes: nonRevenue
            ? "Non-revenue flow (engagement-only). Conv/revenue benchmarks not applicable."
            : "Computed from Klaviyo Reporting API (last_30_days).",
        };
      });
      if (flowPerfRows.length) {
        await mustSucceed("insert flow_performance", sb.from("flow_performance").insert(flowPerfRows));
        const totalRev = flowPerfRows.reduce((s, r) => s + (Number(r.monthly_revenue_current) || 0), 0);
        const totalRecip = flowPerfRows.reduce((s, r) => s + (Number(r.recipients_per_month) || 0), 0);
        if (totalRecip > 0) revenuePerRecipient = totalRev / totalRecip;
      } else {
        reportingErrors.push({
          stage: "flow_performance",
          status: 200,
          message: "No flow reporting rows returned for last_30_days; flow_performance was not populated.",
        });
        // If we got 0 rows at all AND stage 1 used a cached metric, invalidate the cache so next run re-probes.
        if (last30.length === 0 && clientId) {
          await sb.from("klaviyo_connections").update({
            conversion_metric_verified_at: null,
          }).eq("client_id", clientId);
          metricReCacheAt = new Date().toISOString();
        }
      }

      const camp90Rows = campaignReports.find((r) => r.timeframe === "last_90_days")?.results
        ?? campaignReports.find((r) => r.timeframe === "last_30_days")?.results
        ?? [];
      const deliv = extractBounceSpam(camp90Rows);
      bounceRate90d = deliv.bounce;
      spamRate90d = deliv.spam;
    }

    // Merge into rollups: update existing seeded rows with results.
    const camp30Rows = campaignReports.find((r) => r.timeframe === "last_30_days")?.results ?? [];
    const deliverabilitySnapshot = buildDeliverabilitySnapshot(camp30Rows, "last_30_days");
    const flowRows30 = flowReports.find((r) => r.timeframe === "last_30_days")?.results ?? [];
    const revenueBreakdown = buildRevenueBreakdown({
      totalStoreRevenue,
      campaignRowsAllChannels,
      flowRows: flowRows30,
      timeframe: "last_30_days",
    });

    let competingSmsScan: Awaited<ReturnType<typeof runCompetingSmsWebsiteScan>> | null = null;
    if (clientId) {
      try {
        const websiteUrl = await resolveWebsiteUrlForClient(sb, clientId);
        competingSmsScan = await runCompetingSmsWebsiteScan({
          websiteUrl,
          klaviyoSignals: {
            sms_revenue_30d: revenueBreakdown?.sms_revenue ?? null,
            sms_subscribed_profiles: accountSnapshotSeed?.sms_subscribed_profiles_count ?? null,
            has_live_sms_named_flow: flowInventoryHasSmsMarketing(flowRows ?? []),
          },
        });
      } catch {
        // non-critical — analysis continues without storefront SMS scan
      }
    }

    const accountSnapshotFinal = {
      ...(accountSnapshotSeed ?? {}),
      bounce_rate_90d: bounceRate90d,
      spam_rate_90d: spamRate90d,
      deliverability_campaign_timeframe: campaignReports.some((r) => r.timeframe === "last_90_days") ? "last_90_days" : "last_30_days",
      campaign_revenue_per_recipient_30d: computeCampaignRevenuePerRecipient(
        campaignReports.find((r) => r.timeframe === "last_30_days")?.results ?? [],
      ),
      revenue_breakdown: revenueBreakdown,
      deliverability: deliverabilitySnapshot,
      competing_sms_scan: competingSmsScan,
      profile_scan_status: profileScanFull ? "pending" : "skipped",
      computed_at: new Date().toISOString(),
    };
    const derivedMetricsPartial = {
      list_size: 0,
      monthly_engagement: 0,
      revenue_per_recipient: revenuePerRecipient,
    };

    for (const row of rollups ?? []) {
      const tf = row.timeframe_key as "last_30_days" | "last_90_days";
      const camp = campaignReports.find((r) => r.timeframe === tf)?.results ?? [];
      const flw = flowReports.find((r) => r.timeframe === tf)?.results ?? [];
      const prevComputed = (row.computed ?? {}) as Record<string, unknown>;
      const prevCounts = (prevComputed as any).counts ?? {};
      await mustSucceed("update klaviyo_reporting_rollups", sb.from("klaviyo_reporting_rollups")
        .update({
          campaigns: camp,
          flows: flw,
          computed: {
            ...prevComputed,
            counts: prevCounts,
            reporting_errors: reportingErrors,
            account_snapshot: accountSnapshotFinal,
            derived_metrics: derivedMetricsPartial,
            stage: "reporting_complete",
            metric_re_cache_invalidated_at: metricReCacheAt,
          },
        }).eq("id", row.id));
    }

    if (profileScanFull && clientId) {
      await mustSucceed("upsert klaviyo_profile_scan_jobs", sb.from("klaviyo_profile_scan_jobs").upsert({
        audit_id: params.auditId,
        client_id: clientId,
        revision,
        since90_iso: since90,
        next_path: null,
        subscribed: 0,
        active90d: 0,
        suppressed: 0,
        status: "pending",
        staged_revenue_per_recipient: revenuePerRecipient,
        error_message: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "audit_id" }));

      await chainStage("resume_profile_scan", params.auditId);
    } else {
      await chainAuditAnalysis(params.auditId);
    }

    await logStageRun(sb, {
      correlationId: params.correlationId,
      auditId: params.auditId,
      clientId,
      stage: "reporting",
      status: reportingErrors.length ? "partial" : "success",
      revision,
      elapsedMs: Date.now() - startedAt,
      errorMessage: reportingErrors.length ? JSON.stringify(reportingErrors).slice(0, 1000) : null,
    });

    return json({
      ok: true,
      correlationId: params.correlationId,
      stage: "reporting",
      revision,
      reporting: {
        conversion_metric_id: conversionMetricId,
        campaign_reports: campaignReports.map((r) => ({ timeframe: r.timeframe, rows: (r.results ?? []).length })),
        flow_reports: flowReports.map((r) => ({ timeframe: r.timeframe, rows: (r.results ?? []).length })),
        errors: reportingErrors,
        reporting_ok: reportingErrors.length === 0,
      },
      account_snapshot: accountSnapshotFinal,
      derived_metrics: derivedMetricsPartial,
      profile_metrics_status: profileScanFull ? "pending" : "complete",
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (e) {
    const msg = redactSecrets(e instanceof Error ? e.message : "Unknown error");
    await logStageRun(sb, {
      correlationId: params.correlationId,
      auditId: params.auditId,
      clientId,
      stage: "reporting",
      status: "error",
      revision,
      elapsedMs: Date.now() - startedAt,
      errorCode: "reporting_failed",
      errorMessage: msg,
    });
    return json({ ok: false, error: { code: "reporting_failed", message: msg }, correlationId: params.correlationId }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Stage: backfill_revenue_breakdown (non-destructive patch)
// ---------------------------------------------------------------------------

async function runStageBackfillRevenueBreakdown(params: {
  auditId: string;
  correlationId: string;
}): Promise<Response> {
  const startedAt = Date.now();
  const deadlineAtMs = startedAt + 148_000;
  const sb = assertServiceClient();
  let clientId: string | null = null;
  let revision: string = KLAVIYO_REVISION;

  try {
    const { data: audit, error: auditErr } = await sb.from("audits").select("client_id").eq("id", params.auditId).maybeSingle();
    if (auditErr) throw auditErr;
    if (!audit?.client_id) throw new Error("audit not found");
    clientId = audit.client_id as string;

    const { data: conn } = await sb.from("klaviyo_connections")
      .select("revision, conversion_metric_id, timezone")
      .eq("client_id", clientId).maybeSingle();
    revision = KLAVIYO_REVISION;
    const conversionMetricId = (conn?.conversion_metric_id as string | null) || null;
    const accountTimezone = (conn?.timezone as string | null) || "UTC";
    if (!conversionMetricId) throw new Error("No conversion_metric_id on klaviyo_connections");

    const apiKey = await resolveApiKey(sb, clientId, null);
    const { data: rollups } = await sb.from("klaviyo_reporting_rollups")
      .select("id, timeframe_key, computed, flows")
      .eq("audit_id", params.auditId);

    const rollup30 = (rollups ?? []).find((r) => r.timeframe_key === "last_30_days");
    if (!rollup30) throw new Error("No last_30_days rollup found for audit");

    const reportingErrors: Array<{ stage: string; status?: number | null; message: string }> = [];
    const bucket = createReportingBucket({ tokensPerMin: REPORTING_TOKENS_PER_MIN, burst: REPORTING_BURST });

    const campAllChannels30 = await queryValuesReportWithBackoff({
      apiKey,
      revision,
      endpointPath: "/api/campaign-values-reports/",
      timeframeKey: "last_30_days",
      conversionMetricId,
      statistics: ["conversion_value"],
      groupBy: ["campaign_id", "campaign_message_id", "send_channel"],
      deadlineAtMs,
      bucket,
    });
    const campaignRowsAllChannels = campAllChannels30.ok
      ? (campAllChannels30.body?.data?.attributes?.results ?? [])
      : [];
    if (!campAllChannels30.ok) {
      reportingErrors.push({
        stage: "campaign_values_all_channels_last_30_days",
        status: campAllChannels30.status ?? null,
        message: trimBody(campAllChannels30.body) ?? "All-channel campaign values report failed",
      });
    }

    const metricAgg = await queryMetricAggregateSumValueWithRetry({
      apiKey,
      revision,
      metricId: conversionMetricId,
      timezone: accountTimezone,
      days: 30,
    });
    const totalStoreRevenue = metricAgg.ok && metricAgg.sum != null ? metricAgg.sum : null;
    if (!metricAgg.ok) {
      reportingErrors.push({
        stage: "metric_aggregate_total_revenue",
        status: metricAgg.status ?? null,
        message: trimBody(metricAgg.body) ?? "Metric aggregate total revenue failed",
      });
    }

    const flowRows30 = Array.isArray(rollup30.flows) ? rollup30.flows : [];
    const revenueBreakdown = buildRevenueBreakdown({
      totalStoreRevenue,
      campaignRowsAllChannels,
      flowRows: flowRows30,
      timeframe: "last_30_days",
    });

    for (const row of rollups ?? []) {
      const prevComputed = (row.computed ?? {}) as Record<string, unknown>;
      const prevSnapshot = ((prevComputed as any).account_snapshot ?? {}) as Record<string, unknown>;
      const account_snapshot = {
        ...prevSnapshot,
        revenue_breakdown: revenueBreakdown,
        computed_at: new Date().toISOString(),
      };
      await mustSucceed("patch revenue_breakdown", sb.from("klaviyo_reporting_rollups")
        .update({
          computed: {
            ...prevComputed,
            account_snapshot,
            revenue_breakdown_backfilled_at: new Date().toISOString(),
          },
        }).eq("id", row.id));
    }

    await logStageRun(sb, {
      correlationId: params.correlationId,
      auditId: params.auditId,
      clientId,
      stage: "backfill_revenue_breakdown",
      status: reportingErrors.length ? "partial" : "success",
      revision,
      elapsedMs: Date.now() - startedAt,
      errorMessage: reportingErrors.length ? JSON.stringify(reportingErrors).slice(0, 1000) : null,
    });

    return json({
      ok: true,
      correlationId: params.correlationId,
      stage: "backfill_revenue_breakdown",
      revenue_breakdown: revenueBreakdown,
      errors: reportingErrors,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (e) {
    const msg = redactSecrets(e instanceof Error ? e.message : "Unknown error");
    await logStageRun(sb, {
      correlationId: params.correlationId,
      auditId: params.auditId,
      clientId,
      stage: "backfill_revenue_breakdown",
      status: "error",
      revision,
      elapsedMs: Date.now() - startedAt,
      errorCode: "backfill_revenue_breakdown_failed",
      errorMessage: msg,
    });
    return json({ ok: false, error: { code: "backfill_revenue_breakdown_failed", message: msg }, correlationId: params.correlationId }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Stage: backfill_deliverability (non-destructive patch)
// ---------------------------------------------------------------------------

async function runStageBackfillDeliverability(params: {
  auditId: string;
  correlationId: string;
}): Promise<Response> {
  const startedAt = Date.now();
  const deadlineAtMs = startedAt + 148_000;
  const sb = assertServiceClient();
  let clientId: string | null = null;
  let revision: string = KLAVIYO_REVISION;

  const campaignReportStats = [
    "recipients",
    "open_rate",
    "click_rate",
    "bounce_rate",
    "spam_complaint_rate",
    "unsubscribe_rate",
  ];

  try {
    const { data: audit, error: auditErr } = await sb.from("audits").select("client_id").eq("id", params.auditId).maybeSingle();
    if (auditErr) throw auditErr;
    if (!audit?.client_id) throw new Error("audit not found");
    clientId = audit.client_id as string;

    const { data: conn } = await sb.from("klaviyo_connections")
      .select("revision, conversion_metric_id")
      .eq("client_id", clientId).maybeSingle();
    revision = KLAVIYO_REVISION;
    const conversionMetricId = (conn?.conversion_metric_id as string | null) || null;
    if (!conversionMetricId) throw new Error("No conversion_metric_id on klaviyo_connections");

    const apiKey = await resolveApiKey(sb, clientId, null);
    const { data: rollups } = await sb.from("klaviyo_reporting_rollups")
      .select("id, computed")
      .eq("audit_id", params.auditId);
    if (!rollups?.length) throw new Error("No reporting rollups found for audit");

    const reportingErrors: Array<{ stage: string; status?: number | null; message: string }> = [];
    const bucket = createReportingBucket({ tokensPerMin: REPORTING_TOKENS_PER_MIN, burst: REPORTING_BURST });

    const camp30 = await queryValuesReportWithBackoff({
      apiKey,
      revision,
      endpointPath: "/api/campaign-values-reports/",
      timeframeKey: "last_30_days",
      conversionMetricId,
      filter: "contains-any(send_channel,[\"email\"])",
      statistics: campaignReportStats,
      groupBy: ["campaign_id", "campaign_message_id", "send_channel"],
      deadlineAtMs,
      bucket,
    });

    let deliverabilitySnapshot = null;
    if (camp30.ok) {
      const rows = camp30.body?.data?.attributes?.results ?? [];
      deliverabilitySnapshot = buildDeliverabilitySnapshot(rows, "last_30_days");
    } else {
      reportingErrors.push({
        stage: "campaign_values_deliverability_last_30_days",
        status: camp30.status ?? null,
        message: trimBody(camp30.body) ?? "Campaign values report failed (deliverability backfill)",
      });
    }

    for (const row of rollups) {
      const prevComputed = (row.computed ?? {}) as Record<string, unknown>;
      const prevSnapshot = ((prevComputed as any).account_snapshot ?? {}) as Record<string, unknown>;
      const account_snapshot = {
        ...prevSnapshot,
        deliverability: deliverabilitySnapshot,
        computed_at: new Date().toISOString(),
      };
      await mustSucceed("patch deliverability", sb.from("klaviyo_reporting_rollups")
        .update({
          computed: {
            ...prevComputed,
            account_snapshot,
            deliverability_backfilled_at: new Date().toISOString(),
          },
        }).eq("id", row.id));
    }

    await logStageRun(sb, {
      correlationId: params.correlationId,
      auditId: params.auditId,
      clientId,
      stage: "backfill_deliverability",
      status: reportingErrors.length ? "partial" : "success",
      revision,
      elapsedMs: Date.now() - startedAt,
      errorMessage: reportingErrors.length ? JSON.stringify(reportingErrors).slice(0, 1000) : null,
    });

    return json({
      ok: true,
      correlationId: params.correlationId,
      stage: "backfill_deliverability",
      deliverability: deliverabilitySnapshot,
      errors: reportingErrors,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (e) {
    const msg = redactSecrets(e instanceof Error ? e.message : "Unknown error");
    await logStageRun(sb, {
      correlationId: params.correlationId,
      auditId: params.auditId,
      clientId,
      stage: "backfill_deliverability",
      status: "error",
      revision,
      elapsedMs: Date.now() - startedAt,
      errorCode: "backfill_deliverability_failed",
      errorMessage: msg,
    });
    return json({ ok: false, error: { code: "backfill_deliverability_failed", message: msg }, correlationId: params.correlationId }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Stage: backfill_segment_definitions (non-destructive patch)
// ---------------------------------------------------------------------------

async function runStageBackfillSegmentDefinitions(params: {
  auditId: string;
  correlationId: string;
}): Promise<Response> {
  const startedAt = Date.now();
  const sb = assertServiceClient();
  let clientId: string | null = null;
  let revision: string = KLAVIYO_REVISION;

  try {
    const { data: audit, error: auditErr } = await sb.from("audits").select("client_id").eq("id", params.auditId).maybeSingle();
    if (auditErr) throw auditErr;
    if (!audit?.client_id) throw new Error("audit not found");
    clientId = audit.client_id as string;

    const { data: conn } = await sb.from("klaviyo_connections")
      .select("revision")
      .eq("client_id", clientId).maybeSingle();
    revision = KLAVIYO_REVISION;

    const apiKey = await resolveApiKey(sb, clientId, null);

    const [lists, segmentNames, segments, metricsRes, campaignsLive] = await Promise.all([
      klaviyoPaged(apiKey, revision, "/api/lists/", MAX_LIST_PAGES),
      klaviyoPaged(apiKey, revision, SEGMENTS_NAMES_ONLY_PATH, MAX_SEGMENT_NAME_PAGES),
      klaviyoPaged(apiKey, revision, SEGMENTS_WITH_DEFINITIONS_PATH, MAX_SEGMENT_DEFINITION_PAGES),
      klaviyoPaged(apiKey, revision, "/api/metrics/?fields%5Bmetric%5D=name,integration", METRICS_MAX_PAGES),
      klaviyoPaged(apiKey, revision, CAMPAIGNS_WITH_AUDIENCES_PATH, MAX_CAMPAIGN_PAGES),
    ]);

    if (!segments.ok) {
      throw new Error(trimBody(segments.body) ?? "Failed to fetch segments from Klaviyo");
    }

    const metricNameMap = Object.fromEntries(
      (metricsRes.ok ? metricsRes.items : []).map((m: any) => [m.id, m.attributes?.name ?? m.id]),
    );
    let groupNameMap = buildGroupNameMap(
      lists.ok ? lists.items : [],
      [
        ...(segmentNames.ok ? segmentNames.items : []),
        ...segments.items,
      ],
    );
    const campaignItemsForHydrate = campaignsLive.ok ? campaignsLive.items : [];
    const hydrated = await hydrateAudienceIds({
      apiKey,
      revision,
      groupNameMap,
      campaigns: campaignItemsForHydrate,
    });
    groupNameMap = hydrated.groupNameMap;
    const segmentById = new Map<string, any>(
      mergeSegmentItemsForSnapshots(segments.items, hydrated.hydratedSegments).map((s: any) => [s.id, s]),
    );
    const campaignById = new Map<string, any>(
      (campaignsLive.ok ? campaignsLive.items : []).map((c: any) => [c.id, c]),
    );

    const { data: snapshots, error: snapErr } = await sb.from("klaviyo_segment_snapshots")
      .select("id, segment_id, raw")
      .eq("audit_id", params.auditId);
    if (snapErr) throw snapErr;
    if (!snapshots?.length) throw new Error("No segment snapshots found for audit");

    const { data: campaignSnapsPre, error: campPreErr } = await sb.from("klaviyo_campaign_snapshots")
      .select("raw")
      .eq("audit_id", params.auditId);
    if (campPreErr) throw campPreErr;
    const storedCampaignsForHydrate = (campaignSnapsPre ?? []).map((row) => {
      const raw = row.raw as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") return null;
      return { id: (raw as any).id, attributes: (raw as any).attributes };
    }).filter(Boolean);
    const hydratedFromStored = await hydrateAudienceIds({
      apiKey,
      revision,
      groupNameMap,
      campaigns: storedCampaignsForHydrate,
    });
    groupNameMap = hydratedFromStored.groupNameMap;
    for (const s of hydratedFromStored.hydratedSegments) {
      if (s?.id && !segmentById.has(s.id)) segmentById.set(s.id, s);
    }

    let updated = 0;
    let withDefinition = 0;
    let segmentsInserted = 0;
    const existingSegmentIds = new Set(snapshots.map((s) => s.segment_id));
    for (const row of snapshots) {
      const live = segmentById.get(row.segment_id);
      const prevRaw = (row.raw && typeof row.raw === "object") ? row.raw as Record<string, unknown> : {};
      const prevAttrs = (prevRaw.attributes && typeof prevRaw.attributes === "object")
        ? prevRaw.attributes as Record<string, unknown>
        : {};
      const liveAttrs = (live?.attributes && typeof live.attributes === "object") ? live.attributes : {};
      const definition = liveAttrs.definition ?? prevAttrs.definition ?? null;
      if (definition) withDefinition += 1;

      const nextRaw = live
        ? {
          ...prevRaw,
          ...live,
          attributes: {
            ...prevAttrs,
            ...liveAttrs,
            definition,
          },
          _ecd_metric_names: metricNameMap,
        }
        : {
          ...prevRaw,
          _ecd_metric_names: metricNameMap,
        };

      await mustSucceed(
        `update klaviyo_segment_snapshots ${row.id}`,
        sb.from("klaviyo_segment_snapshots").update({
          raw: nextRaw,
          updated_at_klaviyo: liveAttrs.updated
            ? new Date(String(liveAttrs.updated)).toISOString()
            : null,
        }).eq("id", row.id),
      );
      updated += 1;
    }

    const missingSegmentRows = [...segmentById.values()]
      .filter((s) => s?.id && !existingSegmentIds.has(s.id))
      .map((s: any) => ({
        audit_id: params.auditId,
        client_id: clientId,
        segment_id: s.id,
        name: s.attributes?.name ?? "",
        created_at_klaviyo: s.attributes?.created ?? null,
        updated_at_klaviyo: s.attributes?.updated ?? null,
        raw: enrichSegmentRaw(s, metricNameMap),
      }));
    if (missingSegmentRows.length) {
      await insertRowsInBatches(
        "insert hydrated klaviyo_segment_snapshots",
        sb,
        "klaviyo_segment_snapshots",
        missingSegmentRows,
      );
      segmentsInserted = missingSegmentRows.length;
      if (missingSegmentRows.some((r) => (r.raw as any)?.attributes?.definition)) {
        withDefinition += missingSegmentRows.filter((r) => (r.raw as any)?.attributes?.definition).length;
      }
    }

    let campaignsUpdated = 0;
    const { data: campaignSnaps, error: campErr } = await sb.from("klaviyo_campaign_snapshots")
      .select("id, campaign_id, raw")
      .eq("audit_id", params.auditId);
    if (campErr) throw campErr;
    let campaignIndex = 0;
    for (const row of campaignSnaps ?? []) {
      const live = campaignById.get(row.campaign_id);
      const prevRaw = (row.raw && typeof row.raw === "object") ? row.raw as Record<string, unknown> : {};
      const prevAttrs = (prevRaw.attributes && typeof prevRaw.attributes === "object")
        ? prevRaw.attributes as Record<string, unknown>
        : {};
      const liveAttrs = (live?.attributes && typeof live.attributes === "object") ? live.attributes : {};
      const baseRaw = live
        ? {
          ...prevRaw,
          ...live,
          attributes: {
            ...prevAttrs,
            ...liveAttrs,
            audiences: liveAttrs.audiences ?? prevAttrs.audiences ?? null,
          },
        }
        : { ...prevRaw };
      const nextRaw = enrichCampaignRaw(baseRaw, campaignIndex === 0 ? groupNameMap : null);
      campaignIndex += 1;
      await mustSucceed(
        `update klaviyo_campaign_snapshots ${row.id}`,
        sb.from("klaviyo_campaign_snapshots").update({ raw: nextRaw }).eq("id", row.id),
      );
      campaignsUpdated += 1;
    }

    await logStageRun(sb, {
      correlationId: params.correlationId,
      auditId: params.auditId,
      clientId,
      stage: "backfill_segment_definitions",
      status: updated > 0 ? "success" : "partial",
      revision,
      elapsedMs: Date.now() - startedAt,
      errorMessage: updated === 0 ? "No matching Klaviyo segments found for existing snapshots" : null,
    });

    return json({
      ok: true,
      correlationId: params.correlationId,
      stage: "backfill_segment_definitions",
      updated,
      with_definition: withDefinition,
      segments_inserted: segmentsInserted,
      total_snapshots: snapshots.length + segmentsInserted,
      campaigns_updated: campaignsUpdated,
      elapsed_ms: Date.now() - startedAt,
    });
  } catch (e) {
    const msg = redactSecrets(e instanceof Error ? e.message : "Unknown error");
    await logStageRun(sb, {
      correlationId: params.correlationId,
      auditId: params.auditId,
      clientId,
      stage: "backfill_segment_definitions",
      status: "error",
      revision,
      elapsedMs: Date.now() - startedAt,
      errorCode: "backfill_segment_definitions_failed",
      errorMessage: msg,
    });
    return json({
      ok: false,
      error: { code: "backfill_segment_definitions_failed", message: msg },
      correlationId: params.correlationId,
    }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });
  const correlationId = crypto.randomUUID();

  let bodyJson: FetchInput;
  try {
    bodyJson = (await req.json()) as FetchInput;
  } catch {
    return json({ ok: false, error: { code: "bad_request", message: "Invalid JSON body" }, correlationId }, { status: 400 });
  }

  // Normalize legacy `mode` into `stage`.
  const stage: Stage =
    bodyJson.stage ??
    (bodyJson.mode === "resume_profile_scan" ? "resume_profile_scan" : "config");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ ok: false, error: { code: "config_missing", message: "Supabase env missing" }, correlationId }, { status: 500 });
  }

  // Stage-specific auth + dispatch.
  if (stage === "resume_profile_scan" || stage === "reporting" || stage === "profile" || stage === "backfill_revenue_breakdown" || stage === "backfill_deliverability" || stage === "backfill_segment_definitions") {
    // These stages are usually chain-invoked with the service role key; accept either the SR key or a signed-in user (for manual retries).
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const isServiceRole = isServiceRoleAuthorization(token);
    if (!isServiceRole) {
      try {
        await requireAuthenticatedUser(req);
      } catch {
        return json({ ok: false, error: { code: "unauthorized", message: "Invalid authorization" }, correlationId }, { status: 401 });
      }
    }

    const auditId = (bodyJson.audit_id ?? "").trim();
    if (!auditId) {
      return json({ ok: false, error: { code: "bad_request", message: "Missing audit_id" }, correlationId }, { status: 400 });
    }

    try {
      if (stage === "resume_profile_scan") {
        return await handleResumeProfileScan(auditId, correlationId);
      }
      if (stage === "reporting") {
        return await runStageReporting({ auditId, correlationId });
      }
      if (stage === "backfill_revenue_breakdown") {
        return await runStageBackfillRevenueBreakdown({ auditId, correlationId });
      }
      if (stage === "backfill_deliverability") {
        return await runStageBackfillDeliverability({ auditId, correlationId });
      }
      if (stage === "backfill_segment_definitions") {
        return await runStageBackfillSegmentDefinitions({ auditId, correlationId });
      }
      // stage === "profile" — just kicks the resume chain (used by stage 2 and nudges).
      await chainStage("resume_profile_scan", auditId);
      return json({ ok: true, correlationId, stage: "profile", profile_metrics_status: "in_progress" });
    } catch (e) {
      const msg = redactSecrets(e instanceof Error ? e.message : "Unknown error");
      return json({ ok: false, error: { code: `${stage}_failed`, message: msg }, correlationId }, { status: 500 });
    }
  }

  if (stage === "fetch_campaign_email") {
    try {
      await requireAuthenticatedUser(req);
    } catch (e) {
      return json({ ok: false, error: { code: "unauthorized", message: e instanceof Error ? e.message : "Unauthorized" }, correlationId }, { status: 401 });
    }

    const auditId = (bodyJson.audit_id ?? "").trim();
    const campaignId = (bodyJson.campaign_id ?? "").trim();
    if (!auditId || !campaignId) {
      return json({ ok: false, error: { code: "bad_request", message: "Missing audit_id or campaign_id" }, correlationId }, { status: 400 });
    }

    try {
      return await runStageFetchCampaignEmail({
        auditId,
        campaignId,
        persist: Boolean(bodyJson.persist),
        correlationId,
      });
    } catch (e) {
      const msg = redactSecrets(e instanceof Error ? e.message : "Unknown error");
      return json({ ok: false, error: { code: "fetch_campaign_email_failed", message: msg }, correlationId }, { status: 500 });
    }
  }

  // stage === "config" — the entry point called by the frontend.
  try {
    await requireAuthenticatedUser(req);
  } catch (e) {
    return json({ ok: false, error: { code: "unauthorized", message: e instanceof Error ? e.message : "Unauthorized" }, correlationId }, { status: 401 });
  }

  const auditId = (bodyJson.audit_id ?? "").trim();
  const clientId = (bodyJson.client_id ?? "").trim();
  if (!auditId || !clientId) {
    return json({ ok: false, error: { code: "bad_request", message: "Missing audit_id or client_id" }, correlationId }, { status: 400 });
  }
  // The client must be the audit's own. Otherwise one client's stored key could
  // be read into another audit, or an inline key could overwrite theirs.
  try {
    const { data: auditRow, error: auditErr } = await assertServiceClient()
      .from("audits")
      .select("client_id")
      .eq("id", auditId)
      .maybeSingle();
    if (auditErr) throw auditErr;
    if (!auditRow) {
      return json({ ok: false, error: { code: "not_found", message: "Audit not found" }, correlationId }, { status: 404 });
    }
    if (String(auditRow.client_id ?? "") !== clientId) {
      return json({ ok: false, error: { code: "bad_request", message: "client_id does not match the audit" }, correlationId }, { status: 400 });
    }
  } catch (e) {
    const msg = redactSecrets(e instanceof Error ? e.message : "Unknown error");
    return json({ ok: false, error: { code: "config_failed", message: msg }, correlationId }, { status: 500 });
  }

  const revision = resolveKlaviyoRevision(bodyJson.revision);
  const profileScan: "full" | "fast" = bodyJson.profile_scan === "fast" ? "fast" : "full";

  return await runStageConfig({
    auditId,
    clientId,
    apiKeyInline: bodyJson.api_key ?? null,
    revision,
    profileScan,
    correlationId,
  });
});
