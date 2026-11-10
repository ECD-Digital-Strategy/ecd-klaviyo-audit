import { supabase } from './supabase';
import { attachActorNames } from './actor-names';
import { resolvePublicInvoke } from './public-fetch';
import { orIlikeAny } from './search-escape';
import { auditHasAnalysisContent } from './audit-pipeline-status';
import type {
  Audit,
  AuditSection,
  AuditEvent,
  AuditEventType,
  Client,
  Profile,
  Annotation,
  AuditAsset,
  FlowPerformance,
  KlaviyoFlowSnapshot,
  KlaviyoSegmentSnapshot,
  KlaviyoFormSnapshot,
  KlaviyoCampaignSnapshot,
  IndustryEmailLibrary,
  AuditEmailDesign,
  RevenueOpportunityTemplate,
  WebPageSnapshot,
  ShopifyDataSnapshot,
} from './types';
import { applyEntityHighlightStyle, type EntityHighlightStyle } from './entity-highlight-styles';
import { dedupeClientsByCompany, normalizeCompanyKey } from './client-display';
import { normalizeClientWebsiteUrl } from './site-favicon';
import { resolveRevenueOpportunityContent } from './revenue-opportunity-content';
import type { GroupNameMap } from './segment-definition';
import { computeAuditTotalRevenueOpportunity, REVENUE_OPPORTUNITY_SECTION_KEYS } from './revenue-calculator';
import { computeCampaignRevenuePerRecipient } from './campaign-metrics';
import type { DeliverabilitySnapshot } from './deliverability';
import type { RevenueBreakdown } from './revenue-breakdown';
import type { BenchmarkConfig } from './benchmarks';
import type { CoreFlowRecommendations } from './core-flow-recommendations';

const FLOW_SNAPSHOT_SELECT =
  'id, audit_id, client_id, flow_id, name, status, trigger_type, archived, created_at_klaviyo, updated_at_klaviyo, fetched_at, action_count:raw->attributes->action_count, flow_actions:raw->relationships->flow_actions->data';
// Segments/campaigns only need a few fields out of Klaviyo's `raw` API response (segment
// definitions and campaign audience refs), but the full `raw` blob can run into the
// megabytes per row across a few hundred rows -- enough to blow past an edge function's
// memory ceiling (see audit_public). Projecting just the needed JSON paths here cuts that
// by roughly an order of magnitude; `reshapeSegmentSnapshotRow`/`reshapeCampaignSnapshotRow`
// below put the projected fields back under a synthetic `raw` shape so downstream code in
// campaign-audiences.ts/segment-definition.ts (which expects to read through `snapshot.raw...`)
// doesn't need to change.
//
// `_ecd_group_names`/`_ecd_metric_names` are account-wide lookup maps that Klaviyo fetch
// duplicates identically onto every single row's `raw` -- selecting them per-row multiplied
// a ~40KB/~9KB map by hundreds of rows (tens of MB), which was the actual cause of the
// memory ceiling, dwarfing everything else in the payload. They're fetched once via
// `fetchSharedGroupAndMetricNameMaps` below and stitched onto every row in-memory instead.
const SEGMENT_SNAPSHOT_SELECT =
  'id, audit_id, client_id, segment_id, name, created_at_klaviyo, updated_at_klaviyo, fetched_at, is_hidden, display_name, display_notes, display_order, _definition:raw->attributes->definition, _definition_legacy:raw->definition';
const FORM_SNAPSHOT_SELECT =
  'id, audit_id, client_id, form_id, name, status, ab_test, created_at_klaviyo, updated_at_klaviyo, fetched_at, is_hidden, display_name, display_notes, display_order';
const CAMPAIGN_SNAPSHOT_SELECT =
  'id, audit_id, client_id, campaign_id, name, status, send_channel, created_at_klaviyo, updated_at_klaviyo, fetched_at, is_hidden, display_name, display_notes, display_order, _audiences:raw->attributes->audiences';

type SharedGroupAndMetricNameMaps = {
  groupNames: Record<string, unknown> | null;
  metricNames: Record<string, unknown> | null;
};

/** Fetches the account-wide group-name/metric-name maps from a single row instead of
 * every row -- see the comment above SEGMENT_SNAPSHOT_SELECT for why that matters. */
async function fetchSharedGroupAndMetricNameMaps(auditId: string): Promise<SharedGroupAndMetricNameMaps> {
  const [segRow, campRow] = await Promise.all([
    supabase
      .from('klaviyo_segment_snapshots')
      .select('_ecd_group_names:raw->_ecd_group_names, _ecd_metric_names:raw->_ecd_metric_names')
      .eq('audit_id', auditId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from('klaviyo_campaign_snapshots')
      .select('_ecd_group_names:raw->_ecd_group_names')
      .eq('audit_id', auditId)
      .limit(1)
      .maybeSingle(),
  ]);
  const segData = segRow.data as { _ecd_group_names?: Record<string, unknown>; _ecd_metric_names?: Record<string, unknown> } | null;
  const campData = campRow.data as { _ecd_group_names?: Record<string, unknown> } | null;
  return {
    groupNames: segData?._ecd_group_names ?? campData?._ecd_group_names ?? null,
    metricNames: segData?._ecd_metric_names ?? null,
  };
}

/** Reassembles the narrow JSON-path projections above into the `raw` shape that
 * campaign-audiences.ts/segment-definition.ts already know how to read. */
function reshapeSegmentSnapshotRow(
  row: Record<string, unknown>,
  shared: SharedGroupAndMetricNameMaps,
): Record<string, unknown> {
  const { _definition, _definition_legacy, ...rest } = row;
  return {
    ...rest,
    raw: {
      attributes: { definition: _definition ?? undefined },
      definition: _definition_legacy ?? undefined,
      _ecd_metric_names: shared.metricNames ?? undefined,
      _ecd_group_names: shared.groupNames ?? undefined,
    },
  };
}

function reshapeCampaignSnapshotRow(
  row: Record<string, unknown>,
  shared: SharedGroupAndMetricNameMaps,
): Record<string, unknown> {
  const { _audiences, ...rest } = row;
  return {
    ...rest,
    raw: {
      attributes: { audiences: _audiences ?? undefined },
      _ecd_group_names: shared.groupNames ?? undefined,
    },
  };
}

// List views only: no layout or context (large JSON nobody in a list reads).
// executive_summary stays because the list badge checks whether it is empty.
const AUDIT_LIST_COLUMNS =
  'id,client_id,title,status,audit_type,audit_method,list_size,aov,monthly_traffic,total_revenue_opportunity,' +
  'executive_summary,created_by,created_at,updated_at,published_at,public_share_token,show_recommendations,' +
  'web_afters_ready,is_outreach';
const AUDIT_LIST_SELECT = `${AUDIT_LIST_COLUMNS}, audit_sections(audit_id, section_key, revenue_opportunity, section_config)`;

type AuditSectionRevenueRow = {
  audit_id: string;
  section_key: string;
  revenue_opportunity: number;
  section_config?: Record<string, unknown> | null;
};

function attachComputedRevenueOpportunity(audits: Audit[], sections: AuditSectionRevenueRow[]): Audit[] {
  const sectionsByAudit = new Map<string, AuditSectionRevenueRow[]>();
  for (const section of sections) {
    const list = sectionsByAudit.get(section.audit_id) ?? [];
    list.push(section);
    sectionsByAudit.set(section.audit_id, list);
  }

  return audits.map(audit => ({
    ...audit,
    show_recommendations: (audit as Audit & { show_recommendations?: boolean }).show_recommendations ?? true,
    total_revenue_opportunity: computeAuditTotalRevenueOpportunity(
      sectionsByAudit.get(audit.id) ?? [],
      audit.layout,
    ),
  })) as Audit[];
}

async function fetchRevenueSectionsForAudits(auditIds: string[]): Promise<AuditSectionRevenueRow[]> {
  if (auditIds.length === 0) return [];
  const { data, error } = await supabase
    .from('audit_sections')
    .select('audit_id, section_key, revenue_opportunity, section_config')
    .in('audit_id', auditIds)
    .in('section_key', [...REVENUE_OPPORTUNITY_SECTION_KEYS]);
  if (error) throw error;
  return (data ?? []) as AuditSectionRevenueRow[];
}

function mapAuditsWithEmbeddedSections(rows: unknown[]): Audit[] {
  return rows.map(row => {
    const { audit_sections, ...audit } = row as Audit & { audit_sections?: AuditSectionRevenueRow[] };
    const revenueSections = (audit_sections ?? [])
      .filter(section =>
        (REVENUE_OPPORTUNITY_SECTION_KEYS as readonly string[]).includes(section.section_key),
      )
      .map(section => ({ ...section, audit_id: section.audit_id ?? audit.id }));
    return attachComputedRevenueOpportunity([audit as Audit], revenueSections)[0];
  });
}

function finalizePublicReportSections(bundle: Awaited<ReturnType<typeof fetchAuditReportBundleForAudit>>) {
  if (!bundle) return null;
  const approved = bundle.sections.filter(section => section.status === 'approved');
  const finalSections = approved.length > 0 ? approved : bundle.sections;
  const sectionIds = new Set(finalSections.map(section => section.id));
  return {
    ...bundle,
    sections: finalSections,
    annotations: bundle.annotations.filter(annotation => sectionIds.has(annotation.audit_section_id)),
  };
}

type AuditSectionWithAnnotations = AuditSection & { annotations?: Annotation[] | null };

export function flattenSectionsWithAnnotations(rows: AuditSectionWithAnnotations[]): {
  sections: AuditSection[];
  annotations: Annotation[];
} {
  const sections: AuditSection[] = [];
  const annotations: Annotation[] = [];
  for (const row of rows) {
    const { annotations: nested, ...section } = row;
    sections.push(section as AuditSection);
    if (Array.isArray(nested)) {
      annotations.push(...nested);
    }
  }
  return { sections, annotations };
}

function requireUserId(user: Profile | null): string {
  if (!user) throw new Error('Not signed in');
  return user.id;
}

// Outreach prospects (Emil, 2026-11-01) are clients and audits too, flagged
// is_outreach, and live only on the Outreach page: every list below leaves them out.
async function fetchAuditCountByClient(): Promise<Map<string, number>> {
  const { data, error } = await supabase.from('audits').select('client_id').eq('is_outreach', false);
  if (error) throw error;
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const id = row.client_id as string;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

// The counts only break ties between duplicate clients, so a minute-old copy is
// fine for search and lookups: search runs on every keystroke and used to read
// every audit each time. A full client list load always refreshes it.
const AUDIT_COUNT_TTL_MS = 60_000;
let auditCountCache: { at: number; promise: Promise<Map<string, number>> } | null = null;

function getAuditCountByClient(fresh = false): Promise<Map<string, number>> {
  if (!fresh && auditCountCache && Date.now() - auditCountCache.at < AUDIT_COUNT_TTL_MS) {
    return auditCountCache.promise;
  }
  const promise = fetchAuditCountByClient();
  const entry = { at: Date.now(), promise };
  auditCountCache = entry;
  promise.catch(() => {
    if (auditCountCache === entry) auditCountCache = null;
  });
  return promise;
}

export async function findClientByCompanyName(companyName: string): Promise<Client | null> {
  const key = normalizeCompanyKey(companyName);
  if (!key) return null;
  const trimmed = companyName.trim();
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .eq('is_outreach', false)
    .ilike('company_name', trimmed)
    .order('created_at', { ascending: true })
    .limit(20);
  if (error) throw error;
  const matches = (data ?? []).filter(c => normalizeCompanyKey(c.company_name) === key) as Client[];
  if (!matches.length) return null;
  const auditCounts = await getAuditCountByClient();
  return dedupeClientsByCompany(matches, auditCounts)[0] ?? null;
}

export async function listClients(): Promise<Client[]> {
  const [{ data, error }, auditCounts] = await Promise.all([
    supabase.from('clients').select('*').eq('is_outreach', false).order('created_at', { ascending: false }),
    getAuditCountByClient(true),
  ]);
  if (error) throw error;
  return dedupeClientsByCompany((data ?? []) as Client[], auditCounts);
}

export async function getClient(id: string): Promise<Client | null> {
  const { data, error } = await supabase.from('clients').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function createClient(input: Omit<Client, 'id' | 'created_at'>): Promise<Client> {
  const website_url = normalizeClientWebsiteUrl(input.website_url) ?? '';
  // created_by is a uuid column; never send an empty string. Stamp from the
  // current session when a caller did not supply a valid id.
  let created_by: string | null = input.created_by || null;
  if (!created_by) {
    const { data: userData } = await supabase.auth.getUser();
    created_by = userData?.user?.id ?? null;
  }
  const { data, error } = await supabase
    .from('clients')
    .insert({ ...input, website_url, created_by })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function updateClient(id: string, updates: Partial<Omit<Client, 'id' | 'created_at'>>): Promise<Client> {
  const patch = { ...updates };
  if ('website_url' in patch) {
    patch.website_url = normalizeClientWebsiteUrl(patch.website_url) ?? '';
  }
  const { data, error } = await supabase.from('clients').update(patch).eq('id', id).select('*').single();
  if (error) throw error;
  return data as Client;
}

export async function listAdminProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('role', 'admin')
    .order('name');
  if (error) throw error;
  return data ?? [];
}

export async function listAudits(): Promise<Audit[]> {
  const { data, error } = await supabase
    .from('audits')
    .select(AUDIT_LIST_SELECT)
    .eq('is_outreach', false)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return mapAuditsWithEmbeddedSections(data ?? []);
}

export async function listAuditsByClient(clientId: string): Promise<Audit[]> {
  const { data, error } = await supabase
    .from('audits')
    .select(AUDIT_LIST_SELECT)
    .eq('client_id', clientId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return mapAuditsWithEmbeddedSections(data ?? []);
}

export async function searchClients(query: string, limit = 5): Promise<Client[]> {
  const q = query.trim();
  if (!q) return [];
  const [{ data, error }, auditCounts] = await Promise.all([
    supabase
      .from('clients')
      .select('*')
      .eq('is_outreach', false)
      .or(orIlikeAny(['company_name', 'name', 'industry'], q))
      .order('created_at', { ascending: false })
      .limit(Math.max(limit * 3, limit)),
    getAuditCountByClient(),
  ]);
  if (error) throw error;
  return dedupeClientsByCompany((data ?? []) as Client[], auditCounts).slice(0, limit);
}

export async function searchAudits(query: string, limit = 5): Promise<Audit[]> {
  const q = query.trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('audits')
    .select('*')
    .eq('is_outreach', false)
    .ilike('title', `%${q}%`)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as Audit[];
}

export async function getAudit(id: string): Promise<Audit | null> {
  const { data, error } = await supabase.from('audits').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const sections = await fetchRevenueSectionsForAudits([id]);
  return attachComputedRevenueOpportunity([data as Audit], sections)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Activity log: audits have no autosave signal from the DB itself, so every
// content-editing entry point below calls recordAuditEvent. 'edited' events are
// throttled per-audit (recordEditEventThrottled) so a burst of autosaves while
// someone is actively editing collapses into one timeline entry instead of one
// per keystroke; discrete actions (create/publish/status change) always record.

const EDIT_EVENT_THROTTLE_MS = 3 * 60 * 1000;
const lastEditedEventAt = new Map<string, number>();

async function recordAuditEvent(
  auditId: string,
  eventType: AuditEventType,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) return;
    const { error } = await supabase
      .from('audit_events')
      .insert({ audit_id: auditId, event_type: eventType, actor_user_id: userId, metadata });
    if (error) throw error;
  } catch (e) {
    console.error('Failed to record audit event', e);
  }
}

function recordEditEventThrottled(auditId: string): void {
  const now = Date.now();
  const last = lastEditedEventAt.get(auditId) ?? 0;
  if (now - last < EDIT_EVENT_THROTTLE_MS) return;
  lastEditedEventAt.set(auditId, now);
  void recordAuditEvent(auditId, 'edited');
}

export async function listAuditEvents(auditId: string): Promise<AuditEvent[]> {
  const { data, error } = await supabase
    .from('audit_events')
    .select('*')
    .eq('audit_id', auditId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return attachActorNames((data ?? []) as AuditEvent[]);
}

export async function createAudit(input: Omit<Audit, 'id' | 'created_at' | 'updated_at' | 'published_at' | 'public_share_token'>): Promise<Audit> {
  const { data, error } = await supabase.from('audits').insert(input).select('*').single();
  if (error) throw error;
  void recordAuditEvent((data as Audit).id, 'created');
  return data as Audit;
}

// Keys that dedicated entry points (publish/status-change) already log a discrete
// event for -- an updateAudit() call touching only these shouldn't also log 'edited'.
const AUDIT_STRUCTURAL_UPDATE_KEYS = new Set<keyof Audit>(['status', 'public_share_token', 'published_at']);

export async function updateAudit(id: string, updates: Partial<Audit>): Promise<Audit> {
  const { data, error } = await supabase.from('audits').update(updates).eq('id', id).select('*').single();
  if (error) throw error;
  const isContentEdit = Object.keys(updates).some(
    k => !AUDIT_STRUCTURAL_UPDATE_KEYS.has(k as keyof Audit),
  );
  if (isContentEdit) recordEditEventThrottled(id);
  return data as Audit;
}

export async function publishAudit(auditId: string): Promise<Audit> {
  const audit = await getAudit(auditId);
  if (!audit) throw new Error('Audit not found');

  // Sections exist from the moment an audit is created, so their presence proves
  // nothing. Require actual generated content: an audit was once published with
  // seven blank sections and served an empty public report.
  const { data: sectionRows, error: secErr } = await supabase
    .from('audit_sections')
    .select('section_key, summary_text, human_edited_findings, key_findings')
    .eq('audit_id', auditId);
  if (secErr) throw secErr;
  if ((sectionRows ?? []).length === 0) {
    throw new Error("Can't publish yet: no audit sections found. Run the AI analysis first.");
  }
  if (!auditHasAnalysisContent(audit.executive_summary, sectionRows ?? [])) {
    throw new Error(
      "Can't publish yet: this audit has no findings. Run the analysis first, or add findings by hand.",
    );
  }

  const token = audit.public_share_token || crypto.randomUUID().replace(/-/g, '').slice(0, 24);
  const now = new Date().toISOString();
  const result = await updateAudit(auditId, { status: 'published', public_share_token: token, published_at: now });
  void recordAuditEvent(auditId, 'published');
  return result;
}

export async function updateAuditStatus(auditId: string, status: Audit['status']): Promise<Audit> {
  if (status === 'published') return publishAudit(auditId);
  if (status === 'viewer_only') {
    const audit = await getAudit(auditId);
    if (!audit) throw new Error('Audit not found');
    const token = audit.public_share_token || crypto.randomUUID().replace(/-/g, '').slice(0, 24);
    const result = await updateAudit(auditId, { status: 'viewer_only', public_share_token: token });
    void recordAuditEvent(auditId, 'status_changed', { status: 'viewer_only' });
    return result;
  }
  const result = await updateAudit(auditId, { status });
  void recordAuditEvent(auditId, 'status_changed', { status });
  return result;
}

export async function listAuditSections(auditId: string): Promise<AuditSection[]> {
  const { data, error } = await supabase.from('audit_sections').select('*').eq('audit_id', auditId);
  if (error) throw error;
  return (data ?? []) as AuditSection[];
}

export async function updateAuditSection(id: string, updates: Partial<AuditSection>): Promise<AuditSection> {
  const { data, error } = await supabase.from('audit_sections').update(updates).eq('id', id).select('*').single();
  if (error) throw error;
  const auditId = (data as AuditSection).audit_id;
  if (auditId) recordEditEventThrottled(auditId);
  return data as AuditSection;
}

export async function listCampaignSnapshots(auditId: string): Promise<KlaviyoCampaignSnapshot[]> {
  // Never select('*') here: it drags `raw` along, and every row's raw carries
  // the same ~50KB of account-wide name maps, so an audit with a few hundred
  // campaigns shipped tens of MB to fill a picker that reads names and dates.
  // Measured at a 1.5 SECOND mean per call before the column list.
  const { data, error } = await supabase
    .from('klaviyo_campaign_snapshots')
    .select('id, audit_id, client_id, campaign_id, name, status, send_channel, created_at_klaviyo, updated_at_klaviyo, fetched_at, is_hidden, display_name, display_notes, display_order')
    .eq('audit_id', auditId);
  if (error) throw error;
  return (data ?? []) as KlaviyoCampaignSnapshot[];
}

export async function createAuditSections(
  auditId: string,
  sectionKeys: string[],
): Promise<AuditSection[]> {
  const rows = sectionKeys.map(section_key => ({
    audit_id: auditId,
    section_key,
    current_state_title: '',
    optimized_state_title: '',
    current_state_notes: '',
    optimized_notes: '',
    ai_findings: '',
    human_edited_findings: '',
    summary_text: '',
    key_findings: { items: [], items_hidden: [] },
    revenue_opportunity: 0,
    confidence: 'medium',
    status: 'approved',
    section_details: null,
  }));
  const { data, error } = await supabase.from('audit_sections').insert(rows).select('*');
  if (error) throw error;
  return (data ?? []) as AuditSection[];
}

export async function createAnnotation(input: Omit<Annotation, 'id' | 'created_at'>): Promise<Annotation> {
  const { data, error } = await supabase.from('annotations').insert(input).select('*').single();
  if (error) throw error;
  return data as Annotation;
}

export async function deleteAnnotation(id: string): Promise<void> {
  const { error } = await supabase.from('annotations').delete().eq('id', id);
  if (error) throw error;
}

export type AuditReportBundle = {
  audit: Audit;
  client: Client;
  sections: AuditSection[];
  assets: AuditAsset[];
  annotations: Annotation[];
  flowPerformance: FlowPerformance[];
  flowSnapshots: KlaviyoFlowSnapshot[];
  segmentSnapshots: KlaviyoSegmentSnapshot[];
  formSnapshots: KlaviyoFormSnapshot[];
  campaignSnapshots: KlaviyoCampaignSnapshot[];
  emailDesign: AuditEmailDesign | null;
  /** Web-audit-only payloads (empty/absent for Klaviyo audits). */
  webPageSnapshots?: WebPageSnapshot[];
  shopifySnapshots?: ShopifyDataSnapshot[];
  /** Public link of an outreach audit only: the teaser's booking link. */
  teaser?: { locked_total?: number; booking_url?: string | null; about_intro?: string | null } | null;
  reportingDiagnostic?: string | null;
  klaviyoGroupNameMap?: GroupNameMap;
  accountSnapshot?: {
    total_profiles_count?: number | null;
    email_subscribed_profiles_count: number | null;
    sms_subscribed_profiles_count?: number | null;
    active_profiles_90d_count: number | null;
    suppressed_profiles_count: number | null;
    bounce_rate_90d: number | null;
    spam_rate_90d: number | null;
    campaign_revenue_per_recipient_30d?: number | null;
    active_profiles_definition?: string | null;
    computed_at?: string | null;
    email_subscribed_profiles_truncated?: boolean | null;
    active_profiles_90d_truncated?: boolean | null;
    suppressed_profiles_truncated?: boolean | null;
    campaigns_truncated?: boolean | null;
    deliverability_campaign_timeframe?: 'last_30_days' | 'last_90_days' | null;
    profile_scan_status?: 'pending' | 'complete' | 'failed' | 'skipped' | null;
    revenue_breakdown?: RevenueBreakdown | null;
    deliverability?: DeliverabilitySnapshot | null;
  } | null;
};

type RawAuditReportBundle = {
  client: Client | null;
  sections: AuditSectionWithAnnotations[];
  assets: AuditAsset[];
  flowPerformance: FlowPerformance[];
  flowSnapshots: KlaviyoFlowSnapshot[];
  segmentSnapshots: KlaviyoSegmentSnapshot[];
  formSnapshots: KlaviyoFormSnapshot[];
  campaignSnapshots: KlaviyoCampaignSnapshot[];
  rollups: Array<{ timeframe_key: string; computed?: any; campaigns?: any }>;
  emailDesign: AuditEmailDesign | null;
};

/** Shared enrichment (revenue opportunity computation, account snapshot extraction,
 * annotation flattening) applied whether the raw rows came from direct authenticated
 * queries or from the audit_public edge function. */
function hydrateAuditReportBundle(audit: Audit, raw: RawAuditReportBundle): AuditReportBundle | null {
  if (!raw.client) return null;

  const { sections: allSections, annotations } = flattenSectionsWithAnnotations(raw.sections);

  const reportingDiagnostic = raw.rollups
    .find(row => row.timeframe_key === 'last_30_days')?.computed?.reporting_errors?.[0]?.message
    ?? null;

  const rollup30 = raw.rollups.find(row => row.timeframe_key === 'last_30_days');
  const klaviyoGroupNameMap = rollup30?.computed?.group_name_map as GroupNameMap | undefined;
  const accountSnapshotRaw = rollup30?.computed?.account_snapshot ?? null;
  const campaignRprStored = accountSnapshotRaw?.campaign_revenue_per_recipient_30d;
  const campaignRprComputed = computeCampaignRevenuePerRecipient(rollup30?.campaigns);
  const campaignRevenuePerRecipient =
    typeof campaignRprStored === 'number' && Number.isFinite(campaignRprStored)
      ? campaignRprStored
      : campaignRprComputed;
  const accountSnapshot = accountSnapshotRaw
    ? {
        ...accountSnapshotRaw,
        campaign_revenue_per_recipient_30d: campaignRevenuePerRecipient,
      }
    : null;

  const revenueSections = allSections.filter(section =>
    (REVENUE_OPPORTUNITY_SECTION_KEYS as readonly string[]).includes(section.section_key),
  );
  const auditWithRevenue = attachComputedRevenueOpportunity([audit], revenueSections)[0];

  return {
    audit: auditWithRevenue,
    client: raw.client,
    sections: allSections,
    assets: raw.assets,
    annotations,
    flowPerformance: raw.flowPerformance,
    flowSnapshots: raw.flowSnapshots,
    segmentSnapshots: raw.segmentSnapshots,
    formSnapshots: raw.formSnapshots,
    campaignSnapshots: raw.campaignSnapshots,
    emailDesign: raw.emailDesign,
    reportingDiagnostic,
    klaviyoGroupNameMap,
    accountSnapshot,
  };
}

export async function fetchAuditReportBundleForAudit(audit: Audit): Promise<AuditReportBundle | null> {
  const [client, sections, assets, flows, flowSnaps, segSnaps, formSnaps, campSnaps, rollups, emailDesignRes, sharedNames] = await Promise.all([
    supabase.from('clients').select('*').eq('id', audit.client_id).maybeSingle(),
    supabase.from('audit_sections').select('*, annotations(*)').eq('audit_id', audit.id),
    supabase.from('audit_assets').select('*').eq('audit_id', audit.id),
    supabase.from('flow_performance').select('*').eq('audit_id', audit.id),
    supabase.from('klaviyo_flow_snapshots').select(FLOW_SNAPSHOT_SELECT).eq('audit_id', audit.id),
    supabase.from('klaviyo_segment_snapshots').select(SEGMENT_SNAPSHOT_SELECT).eq('audit_id', audit.id),
    supabase.from('klaviyo_form_snapshots').select(FORM_SNAPSHOT_SELECT).eq('audit_id', audit.id),
    supabase.from('klaviyo_campaign_snapshots').select(CAMPAIGN_SNAPSHOT_SELECT).eq('audit_id', audit.id),
    supabase.from('klaviyo_reporting_rollups').select('timeframe_key, computed, campaigns').eq('audit_id', audit.id),
    supabase.from('audit_email_design').select('*, ecd_example:industry_email_library(*)').eq('audit_id', audit.id).maybeSingle(),
    fetchSharedGroupAndMetricNameMaps(audit.id),
  ]);

  if (client.error) throw client.error;
  if (sections.error) throw sections.error;
  if (assets.error) throw assets.error;
  if (flows.error) throw flows.error;
  if (flowSnaps.error) throw flowSnaps.error;
  if (segSnaps.error) throw segSnaps.error;
  if (formSnaps.error) throw formSnaps.error;
  if (campSnaps.error) throw campSnaps.error;
  if (rollups.error) throw rollups.error;

  return hydrateAuditReportBundle(audit, {
    client: client.data as Client | null,
    sections: (sections.data ?? []) as AuditSectionWithAnnotations[],
    assets: (assets.data ?? []) as AuditAsset[],
    flowPerformance: (flows.data ?? []) as FlowPerformance[],
    flowSnapshots: (flowSnaps.data ?? []) as KlaviyoFlowSnapshot[],
    segmentSnapshots: ((segSnaps.data ?? []) as Record<string, unknown>[]).map(row => reshapeSegmentSnapshotRow(row, sharedNames)) as unknown as KlaviyoSegmentSnapshot[],
    formSnapshots: (formSnaps.data ?? []) as KlaviyoFormSnapshot[],
    campaignSnapshots: ((campSnaps.data ?? []) as Record<string, unknown>[]).map(row => reshapeCampaignSnapshotRow(row, sharedNames)) as unknown as KlaviyoCampaignSnapshot[],
    rollups: (rollups.data ?? []) as RawAuditReportBundle['rollups'],
    emailDesign: (emailDesignRes.data ?? null) as AuditEmailDesign | null,
  });
}

/** Public report fetch: validates the share token server-side (service role, no anon
 * RLS involved) via the audit_public edge function, then runs the same enrichment as
 * the authenticated path. Returns null for an unknown/unpublished token. */
export async function fetchPublicAuditReportBundle(token: string): Promise<AuditReportBundle | null> {
  // ?preview=1 is Emil's own link from the Outreach page: not counted as an open.
  const preview = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('preview');
  const res = await supabase.functions.invoke('audit_public', { body: { token, preview } });
  // Null only for a real not found; a backend error throws so the page can offer a retry.
  const data = resolvePublicInvoke<typeof res.data>(res.data, res.error);
  if (!data) return null;

  if ((data.audit as Audit | undefined)?.audit_type === 'web') {
    return {
      audit: data.audit as Audit,
      client: (data.client ?? null) as Client,
      sections: (data.sections ?? []) as AuditSection[],
      assets: [],
      annotations: [],
      flowPerformance: [],
      flowSnapshots: [],
      segmentSnapshots: [],
      formSnapshots: [],
      campaignSnapshots: [],
      emailDesign: null,
      webPageSnapshots: (data.webPageSnapshots ?? []) as WebPageSnapshot[],
      shopifySnapshots: (data.shopifySnapshots ?? []) as ShopifyDataSnapshot[],
      teaser: (data.teaser ?? null) as { locked_total?: number; booking_url?: string | null; about_intro?: string | null } | null,
    };
  }

  const sharedNames: SharedGroupAndMetricNameMaps = {
    groupNames: (data.groupNames ?? null) as Record<string, unknown> | null,
    metricNames: (data.metricNames ?? null) as Record<string, unknown> | null,
  };

  return hydrateAuditReportBundle(data.audit as Audit, {
    client: (data.client ?? null) as Client | null,
    sections: (data.sections ?? []) as AuditSectionWithAnnotations[],
    assets: (data.assets ?? []) as AuditAsset[],
    flowPerformance: (data.flowPerformance ?? []) as FlowPerformance[],
    flowSnapshots: (data.flowSnapshots ?? []) as KlaviyoFlowSnapshot[],
    segmentSnapshots: ((data.segmentSnapshots ?? []) as Record<string, unknown>[]).map(row => reshapeSegmentSnapshotRow(row, sharedNames)) as unknown as KlaviyoSegmentSnapshot[],
    formSnapshots: (data.formSnapshots ?? []) as KlaviyoFormSnapshot[],
    campaignSnapshots: ((data.campaignSnapshots ?? []) as Record<string, unknown>[]).map(row => reshapeCampaignSnapshotRow(row, sharedNames)) as unknown as KlaviyoCampaignSnapshot[],
    rollups: (data.rollups ?? []) as RawAuditReportBundle['rollups'],
    emailDesign: (data.emailDesign ?? null) as AuditEmailDesign | null,
  });
}

export async function fetchAuditWorkspaceShell(auditId: string): Promise<{
  audit: Audit;
  client: Client;
  sections: AuditSection[];
} | null> {
  const { data: audit, error: auditErr } = await supabase.from('audits').select('*').eq('id', auditId).maybeSingle();
  if (auditErr) throw auditErr;
  if (!audit) return null;

  const [client, sections] = await Promise.all([
    supabase.from('clients').select('*').eq('id', audit.client_id).maybeSingle(),
    supabase.from('audit_sections').select('*').eq('audit_id', audit.id),
  ]);

  if (client.error) throw client.error;
  if (sections.error) throw sections.error;
  if (!client.data) return null;

  return {
    audit: audit as Audit,
    client: client.data as Client,
    sections: (sections.data ?? []) as AuditSection[],
  };
}

export interface WebAuditReportBundle {
  audit: Audit;
  client: Client;
  sections: AuditSection[];
  pageSnapshots: WebPageSnapshot[];
  shopifySnapshots: ShopifyDataSnapshot[];
}

/** Lightweight bundle for web audits — separate from the Klaviyo AuditReportBundle. */
export async function fetchWebAuditReportBundle(audit: Audit): Promise<WebAuditReportBundle | null> {
  const [client, sections, pageSnapshots, shopifySnapshots] = await Promise.all([
    supabase.from('clients').select('*').eq('id', audit.client_id).maybeSingle(),
    supabase.from('audit_sections').select('*').eq('audit_id', audit.id),
    supabase.from('web_page_snapshots').select('*').eq('audit_id', audit.id).order('page_type').order('viewport'),
    supabase.from('shopify_data_snapshots').select('*').eq('audit_id', audit.id).order('fetched_at', { ascending: false }),
  ]);
  if (client.error) throw client.error;
  if (sections.error) throw sections.error;
  if (pageSnapshots.error) throw pageSnapshots.error;
  if (shopifySnapshots.error) throw shopifySnapshots.error;
  if (!client.data) return null;
  return {
    audit,
    client: client.data as Client,
    sections: (sections.data ?? []) as AuditSection[],
    pageSnapshots: (pageSnapshots.data ?? []) as WebPageSnapshot[],
    shopifySnapshots: (shopifySnapshots.data ?? []) as ShopifyDataSnapshot[],
  };
}

export async function getAuditReportBundleById(auditId: string): Promise<Awaited<ReturnType<typeof fetchAuditReportBundleForAudit>>> {
  const { data: audit, error } = await supabase.from('audits').select('*').eq('id', auditId).maybeSingle();
  if (error) throw error;
  if (!audit) return null;
  return fetchAuditReportBundleForAudit(audit as Audit);
}

export async function getPublicReportByToken(token: string): Promise<Awaited<ReturnType<typeof fetchAuditReportBundleForAudit>>> {
  // Anonymous path: the audit_public edge function validates the token server-side
  // with the service role (no anon RLS is involved). Falls through to the
  // authenticated staff-preview path below for viewer_only/unpublished audits.
  const publicBundle = await fetchPublicAuditReportBundle(token);
  if (publicBundle) return finalizePublicReportSections(publicBundle);

  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return null;

  let userRole: string | null = null;
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', sessionData.session.user.id)
    .maybeSingle();
  userRole = profile?.role ?? null;
  const isAdmin = userRole === 'admin';

  let query = supabase.from('audits').select('*').eq('public_share_token', token);
  if (!isAdmin) {
    query = query.in('status', ['published', 'viewer_only']);
  }
  const { data: audit, error: auditErr } = await query.maybeSingle();
  if (auditErr) throw auditErr;
  if (!audit) return null;

  if ((audit as Audit).audit_type === 'web') {
    const webBundle = await fetchWebAuditReportBundle(audit as Audit);
    if (!webBundle) return null;
    return {
      audit: webBundle.audit,
      client: webBundle.client,
      sections: webBundle.sections,
      assets: [],
      annotations: [],
      flowPerformance: [],
      flowSnapshots: [],
      segmentSnapshots: [],
      formSnapshots: [],
      campaignSnapshots: [],
      emailDesign: null,
      webPageSnapshots: webBundle.pageSnapshots,
      shopifySnapshots: webBundle.shopifySnapshots,
    };
  }

  const bundle = await fetchAuditReportBundleForAudit(audit as Audit);
  return finalizePublicReportSections(bundle);
}

// --- Industry Email Library ---

export async function listIndustryEmailLibrary(): Promise<IndustryEmailLibrary[]> {
  const { data, error } = await supabase.from('industry_email_library').select('*').order('industry');
  if (error) throw error;
  return (data ?? []) as IndustryEmailLibrary[];
}

export async function createIndustryEmail(input: Omit<IndustryEmailLibrary, 'id' | 'created_at' | 'updated_at'>): Promise<IndustryEmailLibrary> {
  const { data, error } = await supabase.from('industry_email_library').insert(input).select('*').single();
  if (error) throw error;
  return data as IndustryEmailLibrary;
}

export async function updateIndustryEmail(id: string, updates: Partial<IndustryEmailLibrary>): Promise<IndustryEmailLibrary> {
  const { data, error } = await supabase
    .from('industry_email_library')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as IndustryEmailLibrary;
}

export async function deleteIndustryEmail(id: string): Promise<void> {
  const { error } = await supabase.from('industry_email_library').delete().eq('id', id);
  if (error) throw error;
}

// --- Custom Industries ---

export async function listCustomIndustries(): Promise<string[]> {
  const { data, error } = await supabase.from('custom_industries').select('name').order('name');
  if (error) throw error;
  return (data ?? []).map(r => r.name);
}

export async function createCustomIndustry(name: string): Promise<string> {
  const { data, error } = await supabase.from('custom_industries').insert({ name }).select('name').single();
  if (error) throw error;
  return data.name;
}

// --- Audit Email Design ---

export async function getAuditEmailDesign(auditId: string): Promise<AuditEmailDesign | null> {
  const { data, error } = await supabase
    .from('audit_email_design')
    .select('*, ecd_example:industry_email_library(*)')
    .eq('audit_id', auditId)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as AuditEmailDesign | null;
}

export type FetchClientCampaignEmailResult = {
  html: string;
  name: string | null;
  campaignId: string;
};

export async function fetchClientCampaignEmail(
  auditId: string,
  campaignId: string,
  opts?: { persist?: boolean },
): Promise<FetchClientCampaignEmailResult> {
  await supabase.auth.refreshSession().catch(() => {});
  const { data, error } = await supabase.functions.invoke<{
    ok?: boolean;
    html?: string;
    name?: string | null;
    campaign_id?: string;
    error?: { message?: string; code?: string };
  }>('klaviyo_fetch_snapshot', {
    body: {
      stage: 'fetch_campaign_email',
      audit_id: auditId,
      campaign_id: campaignId,
      persist: Boolean(opts?.persist),
    },
  });

  if (error) {
    throw new Error(error.message || 'Failed to fetch campaign email');
  }
  if (!data?.ok || !data.html) {
    const msg = data?.error?.message || 'No email HTML found for this campaign';
    throw new Error(msg);
  }

  return {
    html: data.html,
    name: data.name ?? null,
    campaignId: data.campaign_id ?? campaignId,
  };
}

export async function upsertAuditEmailDesign(
  auditId: string,
  updates: Partial<Omit<AuditEmailDesign, 'id' | 'created_at' | 'ecd_example'>>,
): Promise<AuditEmailDesign> {
  const existing = await getAuditEmailDesign(auditId);
  if (existing) {
    const { data, error } = await supabase
      .from('audit_email_design')
      .update(updates)
      .eq('id', existing.id)
      .select('*, ecd_example:industry_email_library(*)')
      .single();
    if (error) throw error;
    return data as AuditEmailDesign;
  }
  const { data, error } = await supabase
    .from('audit_email_design')
    .insert({ audit_id: auditId, ...updates })
    .select('*, ecd_example:industry_email_library(*)')
    .single();
  if (error) throw error;
  return data as AuditEmailDesign;
}

export async function ensureClientCreator(user: Profile | null, client: Partial<Client>): Promise<Partial<Client>> {
  return { ...client, created_by: requireUserId(user) };
}

// Moved to its own module so the entry chunk does not load db.ts; re-exported for old imports.
export { getPlatformSettings, type PlatformSettings } from './platform-settings-db';

export async function updatePlatformSettings(updates: {
  annotation_size?: string;
  annotations_expanded?: boolean;
  entity_highlight_style?: EntityHighlightStyle;
  benchmarks?: BenchmarkConfig;
  core_flow_recommendations?: CoreFlowRecommendations;
}): Promise<void> {
  const { error } = await supabase
    .from('platform_settings')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', 'default');
  if (error) throw error;
  if (updates.entity_highlight_style) {
    applyEntityHighlightStyle(updates.entity_highlight_style);
  }
}

function coerceTemplateBullets(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map(v => String(v ?? '').trim())
    .filter(Boolean);
}

function mapRevenueOpportunityTemplateRow(row: any): RevenueOpportunityTemplate {
  const bullets = coerceTemplateBullets(row.bullets);
  const content = resolveRevenueOpportunityContent({
    content: row.content ?? '',
    bullets,
  });
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    audit_type: (['web', 'klaviyo', 'both'].includes(row.audit_type) ? row.audit_type : 'both'),
    content,
    bullets,
    default_revenue_monthly: Number(row.default_revenue_monthly ?? 0),
    one_time_price: row.one_time_price != null ? Number(row.one_time_price) : null,
    one_time_label: row.one_time_label ?? null,
    monthly_price: row.monthly_price != null ? Number(row.monthly_price) : null,
    monthly_label: row.monthly_label ?? null,
    image_url: row.image_url ?? null,
    details_url: row.details_url ?? null,
    display_order: Number(row.display_order ?? 0),
    is_active: Boolean(row.is_active),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function uploadReportScreenshot(file: File, prefix: string): Promise<string> {
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${prefix}/${crypto.randomUUID()}_${safeName}`;
  const { error } = await supabase.storage
    .from('audit-assets')
    .upload(path, file, { upsert: false, contentType: file.type });
  if (error) throw error;
  const { data } = supabase.storage.from('audit-assets').getPublicUrl(path);
  if (!data.publicUrl) throw new Error('Failed to get public URL');
  return data.publicUrl;
}

export async function uploadRevenueOpportunityImage(file: File): Promise<string> {
  return uploadReportScreenshot(file, 'revenue-addons');
}

export async function listRevenueOpportunityTemplates(
  options: { activeOnly?: boolean; auditType?: 'web' | 'klaviyo' } = {},
): Promise<RevenueOpportunityTemplate[]> {
  let query = supabase
    .from('revenue_opportunity_templates')
    .select('*')
    .order('display_order', { ascending: true })
    .order('name', { ascending: true });
  if (options.activeOnly) {
    query = query.eq('is_active', true);
  }
  // A web audit shows web + both; a klaviyo audit shows klaviyo + both.
  if (options.auditType) {
    query = query.in('audit_type', [options.auditType, 'both']);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(mapRevenueOpportunityTemplateRow);
}

export async function createRevenueOpportunityTemplate(
  input: Omit<RevenueOpportunityTemplate, 'id' | 'created_at' | 'updated_at'>,
): Promise<RevenueOpportunityTemplate> {
  const content = input.content ?? resolveRevenueOpportunityContent(input);
  const { data, error } = await supabase
    .from('revenue_opportunity_templates')
    .insert({
      ...input,
      content,
      bullets: [],
    })
    .select('*')
    .single();
  if (error) throw error;
  return mapRevenueOpportunityTemplateRow(data);
}

export async function updateRevenueOpportunityTemplate(
  id: string,
  updates: Partial<Omit<RevenueOpportunityTemplate, 'id' | 'created_at' | 'updated_at'>>,
): Promise<RevenueOpportunityTemplate> {
  const payload: Record<string, unknown> = {
    ...updates,
    updated_at: new Date().toISOString(),
  };
  if (updates.content !== undefined) {
    payload.bullets = [];
  }
  const { data, error } = await supabase
    .from('revenue_opportunity_templates')
    .update(payload)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return mapRevenueOpportunityTemplateRow(data);
}

export async function deleteRevenueOpportunityTemplate(id: string): Promise<void> {
  const { error } = await supabase
    .from('revenue_opportunity_templates')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

