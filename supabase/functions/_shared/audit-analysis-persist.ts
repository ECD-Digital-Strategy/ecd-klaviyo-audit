import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  buildCompetingSmsKeyFinding,
  extractRecoveryFlowRevenue,
  injectCompetingSmsFinding,
} from "./competing-sms-finding.ts";
import type { CompetingSmsScanSnapshot } from "./competing-sms-scan.ts";
import { sanitizeDashDeep } from "./dash.ts";
import {
  applyCoreFlowRecommendationsToSectionDetails,
  fetchCoreFlowRecommendations,
} from "./core-flow-recommendations.ts";
import { carryHiddenFlags } from "./klaviyo-audit-logic.ts";

type StoredExecutivePayload = {
  findings?: unknown[];
  strengths?: unknown[];
  timeline?: unknown[];
  findingsHidden?: unknown[];
  strengthsHidden?: unknown[];
  timelineHidden?: unknown[];
};

function parseExecutivePayload(raw: unknown): StoredExecutivePayload {
  try {
    const parsed = JSON.parse(String(raw ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as StoredExecutivePayload : {};
  } catch {
    return {};
  }
}

// MUST match computeAuditTotalRevenueOpportunity in src/lib/revenue-calculator.ts.
// This copy writes audits.total_revenue_opportunity; that one is what every
// screen shows. They had drifted two ways (see below), so the stored total and
// the displayed one disagreed; audit-analysis-persist.test.ts pins the parity.
const REVENUE_SECTION_KEYS = ["flows", "segmentation", "campaigns", "signup_forms", "email_design"];

export function defaultEmailDesignRevenue(totalExcludingEmail: number): number {
  return Math.max(300, Math.round(totalExcludingEmail * 0.1));
}

/** The report editor stores "hidden" at section_config[sectionKey].hidden, which
 * is where the frontend reads it. This used to read section_config.hidden at the
 * root, which nothing ever sets, so a hidden section was always counted: the
 * June HigherDose audit stored $16,100 against the $14,300 its report shows. */
function sectionVisible(sectionKey: string, sectionConfig: unknown): boolean {
  if (!sectionConfig || typeof sectionConfig !== "object") return true;
  const own = (sectionConfig as Record<string, unknown>)[sectionKey];
  if (!own || typeof own !== "object") return true;
  return (own as Record<string, unknown>).hidden !== true;
}

/** Sections only. Add-ons used to be added in as revenue estimates; since they
 * became ECD's own priced services (one-time and monthly fees the client pays)
 * they are a cost, not an opportunity, and the frontend dropped them. This copy
 * kept adding them. The layout parameter is kept for the call sites. */
export function computeAuditTotalRevenueOpportunity(
  sections: Array<{ section_key?: string; revenue_opportunity?: number; section_config?: unknown }>,
  _layout?: unknown,
): number {
  return sections
    .filter((s) => s.section_key && REVENUE_SECTION_KEYS.includes(s.section_key))
    .filter((s) => sectionVisible(s.section_key!, s.section_config ?? null))
    .reduce((sum, s) => sum + (Number(s.revenue_opportunity) || 0), 0);
}

export type AddOnPlacementPersist = {
  template_slug: string;
  section_keys: string[];
  presenter_note: string;
};

type PartialState = {
  executiveSummary?: string;
  findings?: string[];
  strengths?: string[];
  implementationTimeline?: unknown[];
  sections?: Array<Record<string, unknown>>;
  addOnPlacements?: AddOnPlacementPersist[];
};

function mergeAddOnPlacementsIntoLayout(
  layout: unknown,
  placements: AddOnPlacementPersist[] | undefined,
  options?: { clearUnplaced?: boolean },
): Record<string, unknown> {
  const layoutObj = { ...((layout as Record<string, unknown> | null | undefined) ?? {}) };
  const revenueSummary = { ...((layoutObj.revenue_summary as Record<string, unknown> | undefined) ?? {}) };
  const blocks = { ...((revenueSummary.blocks as Record<string, unknown> | undefined) ?? {}) };
  const addOns = { ...((blocks.addOns as Record<string, unknown> | undefined) ?? {}) };
  const items = Array.isArray(addOns.items) ? [...(addOns.items as Array<Record<string, unknown>>)] : [];

  if (!placements?.length) {
    if (!options?.clearUnplaced || items.length === 0) return layoutObj;
    for (let i = 0; i < items.length; i++) {
      const { related_section_keys: _r, presenter_note: _p, ...rest } = items[i];
      items[i] = rest;
    }
    addOns.items = items;
    blocks.addOns = addOns;
    revenueSummary.blocks = blocks;
    layoutObj.revenue_summary = revenueSummary;
    return layoutObj;
  }

  const bySlug = new Map(placements.map((p) => [p.template_slug, p]));

  for (let i = 0; i < items.length; i++) {
    const slug = String(items[i]?.template_slug ?? "").trim();
    const placement = bySlug.get(slug);
    if (placement) {
      items[i] = {
        ...items[i],
        related_section_keys: placement.section_keys,
        presenter_note: placement.presenter_note,
      };
    } else if (options?.clearUnplaced) {
      const { related_section_keys: _r, presenter_note: _p, ...rest } = items[i];
      items[i] = rest;
    }
  }

  addOns.items = items;
  blocks.addOns = addOns;
  revenueSummary.blocks = blocks;
  layoutObj.revenue_summary = revenueSummary;
  return layoutObj;
}

export async function persistAuditAnalysisResults(
  sb: SupabaseClient,
  auditId: string,
  partialInput: PartialState,
  options?: {
    patchOnlySectionKeys?: string[];
    preserveStrengthsFromAudit?: boolean;
  },
): Promise<void> {
  // House style, enforced where the copy is written rather than only asked for
  // in the prompt. Every other generated-copy path (web audits, the proposal and
  // document agents) strips em and en dashes in code because the prompt rule
  // alone did not hold; the Klaviyo path was the one that never got it, so a
  // dash could still reach a client's report. One pass over the whole payload
  // covers the summary, the findings, the strengths, the timeline and every
  // section's text without having to name each field.
  const partial = sanitizeDashDeep(partialInput);
  const { data: audit, error: auditErr } = await sb
    .from("audits")
    .select("id, layout, client_id, executive_summary")
    .eq("id", auditId)
    .single();
  if (auditErr || !audit) throw auditErr ?? new Error("Audit not found");

  let preservedStrengths: string[] | null = null;
  if (options?.preserveStrengthsFromAudit) {
    try {
      const parsed = JSON.parse(String(audit.executive_summary ?? ""));
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.strengths)) {
        preservedStrengths = parsed.strengths.map((s: string) => String(s));
      }
    } catch {
      preservedStrengths = null;
    }
  }

  const strengthsForExec = preservedStrengths ?? (partial.strengths ?? []);

  const { data: sectionRows, error: sectionsErr } = await sb
    .from("audit_sections")
    .select("id, section_key, revenue_opportunity, section_config, key_findings")
    .eq("audit_id", auditId);
  if (sectionsErr) throw sectionsErr;

  const storedKfByKey = new Map(
    (sectionRows ?? []).map((s) => [String(s.section_key), (s.key_findings ?? null) as { items?: unknown[]; items_hidden?: unknown[] } | null]),
  );
  const recommendations = await fetchCoreFlowRecommendations(sb);
  const patches = (partial.sections ?? []).map((patch) => {
    let next: Record<string, unknown> = { ...patch };
    const rawKf = (patch as { key_findings?: { items?: string[] } }).key_findings;
    if (rawKf?.items?.length) {
      const items = rawKf.items.map((item) => String(item).trim()).filter(Boolean);
      // Keep what the editor hid: an unchanged item keeps its flag (or by
      // position when the count matches). This used to reset every flag.
      const stored = storedKfByKey.get(String(patch.section_key));
      next = {
        ...next,
        key_findings: {
          items,
          items_hidden: carryHiddenFlags(stored?.items, stored?.items_hidden, items),
        },
      };
    }
    if (String(patch.section_key) !== "flows" || !patch.section_details) return next;
    return {
      ...next,
      section_details: applyCoreFlowRecommendationsToSectionDetails(
        patch.section_details,
        recommendations,
      ),
    };
  });
  const patchByKey = new Map(patches.map((p) => [String(p.section_key), p]));
  // A provided list (even an empty one) means patch only those sections; a
  // highlight regen with no placements must not rewrite every section.
  const patchOnly = options?.patchOnlySectionKeys ? new Set(options.patchOnlySectionKeys) : null;

  for (const section of sectionRows ?? []) {
    const patch = patchByKey.get(section.section_key);
    if (!patch || section.section_key === "email_design") continue;
    if (patchOnly && !patchOnly.has(section.section_key)) continue;
    const { section_key: _sk, ...rest } = patch;
    const { error: updErr } = await sb.from("audit_sections").update(rest).eq("id", section.id);
    if (updErr) throw new Error(`update audit_sections ${section.section_key} failed: ${updErr.message}`);
  }

  const mergedSections = (sectionRows ?? []).map((section) => {
    const patch = patchByKey.get(section.section_key);
    if (!patch) return section;
    if (patchOnly && !patchOnly.has(section.section_key)) return section;
    return { ...section, ...patch };
  });

  const opportunityBaseBeforeEmail = computeAuditTotalRevenueOpportunity(
    mergedSections.map((s) =>
      s.section_key === "email_design" ? { ...s, revenue_opportunity: 0 } : s,
    ),
    audit.layout,
  );

  const emailSection = (sectionRows ?? []).find((s) => s.section_key === "email_design");
  const emailPatch = patchByKey.get("email_design");
  if (emailSection && emailPatch && (!patchOnly || patchOnly.has("email_design"))) {
    const aiEmailRevenue = Number(emailPatch.revenue_opportunity) || 0;
    const emailRevenue = aiEmailRevenue > 0
      ? aiEmailRevenue
      : defaultEmailDesignRevenue(opportunityBaseBeforeEmail);
    const { section_key: _sk, ...rest } = emailPatch;
    const { error: emailErr } = await sb.from("audit_sections")
      .update({ ...rest, revenue_opportunity: emailRevenue })
      .eq("id", emailSection.id);
    if (emailErr) throw new Error(`update audit_sections email_design failed: ${emailErr.message}`);
  }

  const patchedSections = mergedSections.map((section) => {
    const patch = patchByKey.get(section.section_key);
    if (!patch) return section;
    if (patchOnly && !patchOnly.has(section.section_key)) return section;
    if (section.section_key === "email_design") {
      const aiEmailRevenue = Number(patch.revenue_opportunity) || 0;
      return {
        ...section,
        ...patch,
        revenue_opportunity: aiEmailRevenue > 0
          ? aiEmailRevenue
          : defaultEmailDesignRevenue(opportunityBaseBeforeEmail),
      };
    }
    return { ...section, ...patch };
  });

  const mergedLayout = mergeAddOnPlacementsIntoLayout(
    audit.layout,
    partial.addOnPlacements,
    { clearUnplaced: Boolean(options?.preserveStrengthsFromAudit) },
  );
  const totalOpportunity = computeAuditTotalRevenueOpportunity(patchedSections, mergedLayout);

  let findingsForExec = partial.findings ?? [];
  try {
    const { data: rollup } = await sb
      .from("klaviyo_reporting_rollups")
      .select("computed")
      .eq("audit_id", auditId)
      .eq("timeframe_key", "last_30_days")
      .maybeSingle();
    const snapshot = (rollup?.computed as { account_snapshot?: { competing_sms_scan?: CompetingSmsScanSnapshot } } | null)
      ?.account_snapshot;
    const scan = snapshot?.competing_sms_scan;
    if (scan?.should_inject_finding && scan.detected_platforms?.length) {
      const { data: flowPerf } = await sb
        .from("flow_performance")
        .select("flow_name, monthly_revenue_current")
        .eq("audit_id", auditId);
      const recovery = extractRecoveryFlowRevenue(flowPerf ?? []);
      const finding = buildCompetingSmsKeyFinding(scan.detected_platforms, recovery);
      findingsForExec = injectCompetingSmsFinding(findingsForExec, finding);
    }
  } catch {
    // non-critical
  }

  // What the editor hid in the summary blocks survives a regeneration: flags
  // follow unchanged items (or position when the count matches).
  const prevExec = parseExecutivePayload(audit.executive_summary);
  const timelineForExec = partial.implementationTimeline ?? [];
  const hiddenCarry: Record<string, boolean[]> = {};
  const findingsHidden = carryHiddenFlags(prevExec.findings, prevExec.findingsHidden, findingsForExec);
  const strengthsHidden = carryHiddenFlags(prevExec.strengths, prevExec.strengthsHidden, strengthsForExec);
  const timelineHidden = carryHiddenFlags(prevExec.timeline, prevExec.timelineHidden, timelineForExec);
  if (findingsHidden.some(Boolean)) hiddenCarry.findingsHidden = findingsHidden;
  if (strengthsHidden.some(Boolean)) hiddenCarry.strengthsHidden = strengthsHidden;
  if (timelineHidden.some(Boolean)) hiddenCarry.timelineHidden = timelineHidden;

  const execPayload = (strengthsForExec.length || findingsForExec.length || timelineForExec.length)
    ? JSON.stringify({
      text: partial.executiveSummary ?? "",
      findings: findingsForExec,
      strengths: strengthsForExec,
      timeline: timelineForExec,
      ...hiddenCarry,
    })
    : (partial.executiveSummary ?? "");

  const { error: auditUpdErr } = await sb.from("audits").update({
    executive_summary: execPayload,
    layout: mergedLayout,
    total_revenue_opportunity: totalOpportunity,
    updated_at: new Date().toISOString(),
  }).eq("id", auditId);
  if (auditUpdErr) throw new Error(`update audits analysis failed: ${auditUpdErr.message}`);

  try {
    const { data: client } = await sb.from("clients").select("industry").eq("id", audit.client_id).maybeSingle();
    const industry = (client?.industry ?? "").trim();
    // Only on a full analysis. A highlight regen (patchOnly) must not reset the
    // chosen industry example or insert the default annotations again.
    // An example already chosen (by a person or an earlier run) is kept, and
    // with it the annotations, so a re-run never duplicates them.
    const { data: existingDesign } = await sb
      .from("audit_email_design")
      .select("ecd_example_id")
      .eq("audit_id", auditId)
      .maybeSingle();
    if (industry && !patchOnly && !existingDesign?.ecd_example_id) {
      const { data: ecdExample } = await sb
        .from("industry_email_library")
        .select("id, default_annotations")
        .eq("industry", industry)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (ecdExample) {
        await sb.from("audit_email_design").upsert({
          audit_id: auditId,
          ecd_example_id: ecdExample.id,
        }, { onConflict: "audit_id" });
        const emailDesignSection = (sectionRows ?? []).find((s) => s.section_key === "email_design");
        const annotations = Array.isArray(ecdExample.default_annotations) ? ecdExample.default_annotations : [];
        if (emailDesignSection && annotations.length) {
          for (const ann of annotations as Array<{ x: number; y: number; label: string }>) {
            await sb.from("annotations").insert({
              audit_section_id: emailDesignSection.id,
              asset_id: null,
              x_position: ann.x,
              y_position: ann.y,
              label: ann.label,
              side: "optimized",
            });
          }
        }
      }
    }
  } catch {
    // non-critical
  }
}
