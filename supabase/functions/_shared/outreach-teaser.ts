// The teaser an outreach audit's public link shows (Emil, 2026-11-01): "more of a
// teaser but still insightful, so they know we know what we're talking about".
//
// Each page keeps its strongest findings per screen size (desktop and mobile, a
// finding tagged "both" counting for each): all but the two weakest, at least one
// (teaserShowCount), recommendations included. Everything
// else is taken out of the payload, not just hidden, so the full audit never
// reaches the prospect's browser; the page says how many more there are. The
// roadmap with pricing and the sales analytics are hidden. The email writer
// (outreach_draft) picks from the same kept findings, so the email never points
// at something the report does not show.

export const TEASER_PAGE_KEYS = ["web_homepage", "web_product_page", "web_collection_page", "web_cart"] as const;
export const TEASER_HIDDEN_KEYS = ["web_revenue_summary", "web_performance"] as const;

export type TeaserFinding = {
  title?: string | null;
  text?: string | null;
  recommendation?: string | null;
  priority?: string | null;
  viewport?: string | null;
  hidden?: boolean | null;
  removed?: boolean | null;
  [k: string]: unknown;
};

const RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
const rank = (f: TeaserFinding) => RANK[String(f.priority ?? "").toLowerCase()] ?? 1;
const live = (f: TeaserFinding) => !f.hidden && !f.removed && Boolean(String(f.text ?? "").trim());
const onViewport = (f: TeaserFinding, v: "desktop" | "mobile") => {
  const vp = String(f.viewport ?? "both").toLowerCase();
  return vp === v || vp === "both" || vp === "";
};

/** How many of a screen size's findings the teaser shows (Emil, 2026-11-02): all
 * but the two weakest, and always at least one. 3 shows 1, 4 shows 2, 5 shows 3. */
export function teaserShowCount(total: number): number {
  return total <= 0 ? 0 : Math.max(1, total - 2);
}

/** The findings a page keeps, and how many each screen size has locked away. */
export function teaserFindings(findings: TeaserFinding[]): {
  kept: TeaserFinding[];
  locked: { desktop: number; mobile: number };
} {
  const shown = findings.filter(live);
  const keep = new Set<TeaserFinding>();
  for (const v of ["desktop", "mobile"] as const) {
    // Strongest first; a stable sort keeps the analyst's order on equal priority.
    const onThis = shown
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => onViewport(f, v))
      .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i);
    // A "both" finding already kept for the other screen counts toward this one too,
    // so a screen never shows more than its number.
    let room = teaserShowCount(onThis.length) - onThis.filter(({ f }) => keep.has(f)).length;
    for (const { f } of onThis) {
      if (room <= 0) break;
      if (keep.has(f)) continue;
      keep.add(f);
      room--;
    }
  }
  const kept = shown.filter((f) => keep.has(f));
  const lockedOn = (v: "desktop" | "mobile") => shown.filter((f) => onViewport(f, v) && !keep.has(f)).length;
  return { kept, locked: { desktop: lockedOn("desktop"), mobile: lockedOn("mobile") } };
}

type Section = { section_key?: string; section_details?: Record<string, unknown> | null; [k: string]: unknown };

/** Sections as the public link serves them for an outreach audit. */
export function teaserSections<T extends Section>(sections: T[]): T[] {
  return sections
    .filter((s) => !(TEASER_HIDDEN_KEYS as readonly string[]).includes(String(s.section_key)))
    .map((s) => {
      if (!(TEASER_PAGE_KEYS as readonly string[]).includes(String(s.section_key))) return s;
      const details = (s.section_details ?? {}) as Record<string, unknown>;
      const web = (details.web ?? {}) as Record<string, unknown>;
      const findings = Array.isArray(web.findings) ? (web.findings as TeaserFinding[]) : [];
      const { kept, locked } = teaserFindings(findings);
      // The page renders only the kept findings, so the other copies of the
      // section's findings (which the web report never reads) are blanked too:
      // otherwise the locked ones would still reach the prospect's browser.
      return {
        ...s,
        key_findings: { items: [], items_hidden: [] },
        ai_findings: "",
        human_edited_findings: "",
        section_details: { ...details, web: { ...web, findings: kept, locked_findings: locked } },
      };
    });
}

// ---------------------------------------------------------------------------
// Public report redaction (audit_public)
//
// The public link must not carry anything the report hides. Hidden copy is
// replaced or removed here, server side, in a way that leaves what the report
// renders unchanged: the frontend's own resolve steps (src/lib/findings-normalize.ts,
// src/lib/section-key-findings.ts) still see the same visible items at the same
// positions, so their hidden flags keep lining up.
// ---------------------------------------------------------------------------

/** Port of src/lib/findings-normalize.ts isFindingContinuation. Keep in sync. */
function isFindingContinuation(prev: string, next: string): boolean {
  const p = prev.trim();
  const n = next.trim();
  if (!p || !n) return false;
  if (/^[a-z]{1,8}(\*\*)?[,\s]/.test(n)) return true;
  const boldCount = (p.match(/\*\*/g) ?? []).length;
  if (boldCount % 2 === 1 && /^[a-z]/.test(n)) return true;
  if (/[a-zA-Z]$/.test(p) && !/[.!?]$/.test(p)) {
    if (/^[a-z]/.test(n)) return true;
    if (/ [A-Z]$/.test(p)) return true;
  }
  return false;
}

function mergeFindingContinuation(prev: string, next: string): string {
  const p = prev.trimEnd();
  const n = next.trimStart();
  if (/[a-zA-Z]$/.test(p) && /^[a-z]/.test(n)) return p + n;
  return `${p} ${n}`;
}

function repairBrokenBoldMarkers(text: string): string {
  const count = (text.match(/\*\*/g) ?? []).length;
  return count % 2 === 1 ? `${text}**` : text;
}

/** Port of src/lib/findings-normalize.ts repairSplitFindings. The report's hidden
 * flags index into THIS list, not the raw one, so redaction works on it too. */
export function repairSplitFindings(items: string[]): string[] {
  const raw = items.map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const item of raw) {
    if (out.length === 0) {
      out.push(item);
      continue;
    }
    const prev = out[out.length - 1];
    if (isFindingContinuation(prev, item)) {
      out[out.length - 1] = repairBrokenBoldMarkers(mergeFindingContinuation(prev, item));
    } else {
      out.push(item);
    }
  }
  return out.map(repairBrokenBoldMarkers);
}

/** Stands in for a hidden item. Never shown (its hidden flag stays set), not
 * empty (an all-empty list would make the report fall back to legacy prose),
 * and it can neither absorb nor be absorbed by a neighbour in repairSplitFindings. */
export const HIDDEN_ITEM_PLACEHOLDER = ".";

/** Replace hidden items in a repaired findings list with the placeholder. */
function maskHidden(items: string[], hidden: boolean[]): string[] {
  const repaired = repairSplitFindings(items);
  return repaired.map((t, i) => (hidden[i] ? HIDDEN_ITEM_PLACEHOLDER : t));
}

/** A section or layout key_findings value ({ items, items_hidden }) with the
 * hidden items' text taken out. Unchanged when nothing is hidden. */
export function redactKeyFindings(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  const hiddenRaw = Array.isArray(obj.items_hidden) ? obj.items_hidden.map(Boolean) : [];
  if (!hiddenRaw.some(Boolean)) return raw;
  const items = Array.isArray(obj.items) ? obj.items.map((i) => String(i ?? "")) : [];
  // No real items: the report shows the legacy prose instead, still governed by
  // these flags, so they are kept.
  if (!items.some((i) => i.trim())) return { items: [], items_hidden: hiddenRaw };
  const masked = maskHidden(items, hiddenRaw);
  return { items: masked, items_hidden: masked.map((_, i) => Boolean(hiddenRaw[i])) };
}

const EMPTY_PHASE = { phase: "", timeframe: "", label: "", items: [] as string[] };

/** audits.executive_summary (a JSON string, or plain text) with hidden findings,
 * strengths and timeline phases taken out. Plain text and payloads with nothing
 * hidden come back as they were. */
export function redactExecutiveSummary(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return value;
  let parsed: Record<string, unknown>;
  try {
    const p = JSON.parse(value);
    if (!p || typeof p !== "object" || Array.isArray(p)) return value;
    parsed = p as Record<string, unknown>;
  } catch {
    return value;
  }
  const out: Record<string, unknown> = { ...parsed };
  let changed = false;

  const findings = Array.isArray(parsed.findings) ? (parsed.findings as unknown[]).map((f) => String(f ?? "")) : undefined;
  const concerns = Array.isArray(parsed.concerns) ? (parsed.concerns as unknown[]).map((f) => String(f ?? "")) : undefined;
  const findingsHidden = Array.isArray(parsed.findingsHidden) ? (parsed.findingsHidden as unknown[]).map(Boolean) : [];
  const useFindings = Boolean(findings?.some((f) => f.trim()));
  // Concerns are only shown when there are no findings; drop them when unused.
  if (useFindings && concerns && concerns.length > 0) {
    out.concerns = [];
    changed = true;
  }
  if (findingsHidden.some(Boolean)) {
    const base = useFindings ? findings! : concerns ?? [];
    const masked = maskHidden(base, findingsHidden);
    if (masked.length > 0) {
      out.findings = masked;
      out.concerns = [];
      out.findingsHidden = masked.map((_, i) => Boolean(findingsHidden[i]));
      changed = true;
    }
  }

  const strengthsHidden = Array.isArray(parsed.strengthsHidden) ? (parsed.strengthsHidden as unknown[]).map(Boolean) : [];
  if (Array.isArray(parsed.strengths) && strengthsHidden.some(Boolean)) {
    out.strengths = (parsed.strengths as unknown[]).map((s, i) => (strengthsHidden[i] ? "" : s));
    changed = true;
  }

  const timelineHidden = Array.isArray(parsed.timelineHidden) ? (parsed.timelineHidden as unknown[]).map(Boolean) : [];
  if (Array.isArray(parsed.timeline) && timelineHidden.some(Boolean)) {
    out.timeline = (parsed.timeline as unknown[]).map((p, i) => (timelineHidden[i] ? { ...EMPTY_PHASE } : p));
    changed = true;
  }

  return changed ? JSON.stringify(out) : value;
}

/** Layout blocks that carry their own key_findings (deliverability, attribution). */
const LAYOUT_KEY_FINDINGS_KEYS = ["deliverability_snapshot", "attribution_model"] as const;

export function redactLayout(layout: unknown): unknown {
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) return layout;
  const out: Record<string, unknown> = { ...(layout as Record<string, unknown>) };
  for (const key of LAYOUT_KEY_FINDINGS_KEYS) {
    const block = out[key];
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const b = block as Record<string, unknown>;
    if (!("key_findings" in b)) continue;
    out[key] = { ...b, key_findings: redactKeyFindings(b.key_findings) };
  }
  return out;
}

/** Whether the report hides this section (section_config[section_key].hidden),
 * the rule both report views use. */
export function isSectionHidden(section: Section): boolean {
  const cfg = (section as { section_config?: unknown }).section_config;
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return false;
  const inner = (cfg as Record<string, unknown>)[String(section.section_key)];
  return Boolean(inner && typeof inner === "object" && (inner as Record<string, unknown>).hidden === true);
}

const BLANK_TEXT = {
  summary_text: "",
  ai_findings: "",
  human_edited_findings: "",
  current_state_notes: "",
  optimized_notes: "",
  key_findings: { items: [], items_hidden: [] },
};

/** Whether a section's key_findings has real items (then the legacy prose
 * fallback in human_edited_findings is never shown). */
function hasKeyFindingItems(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const items = (raw as Record<string, unknown>).items;
  return Array.isArray(items) && items.some((i) => String(i ?? "").trim());
}

/**
 * One Klaviyo report section as the public link serves it. A hidden section
 * keeps its row and config (the report reads its hidden flag from there, and
 * its revenue_opportunity still counts toward the total) but loses its copy.
 * ai_findings is never rendered, and human_edited_findings only as a fallback.
 */
export function redactKlaviyoSection<T extends Section>(section: T): T {
  if (isSectionHidden(section)) {
    return { ...section, ...BLANK_TEXT, ...("annotations" in section ? { annotations: [] } : {}) };
  }
  const kf = (section as { key_findings?: unknown }).key_findings;
  const hasItems = hasKeyFindingItems(kf);
  // With no items the legacy prose is the one finding shown, and the first
  // hidden flag governs it.
  const legacyHidden = !hasItems && kf && typeof kf === "object" && !Array.isArray(kf) &&
    Array.isArray((kf as Record<string, unknown>).items_hidden) &&
    Boolean(((kf as Record<string, unknown>).items_hidden as unknown[])[0]);
  return {
    ...section,
    ai_findings: "",
    ...(hasItems ? { human_edited_findings: "" } : {}),
    ...(legacyHidden ? { human_edited_findings: "", summary_text: "" } : {}),
    key_findings: redactKeyFindings(kf),
  };
}

/**
 * One web report section as the public link serves it. Hidden findings and
 * ones taken out of a page are dropped (the page numbers what it shows, so
 * nothing moves). A hidden section keeps its row and config, and only the
 * teaser's locked count from its details, which the teaser banner adds up.
 */
export function redactWebSection<T extends Section>(section: T): T {
  const details = (section.section_details ?? {}) as Record<string, unknown>;
  const web = details.web && typeof details.web === "object" && !Array.isArray(details.web)
    ? (details.web as Record<string, unknown>)
    : null;
  if (isSectionHidden(section)) {
    const locked = web?.locked_findings;
    return {
      ...section,
      ...BLANK_TEXT,
      section_details: locked ? { web: { locked_findings: locked } } : {},
    };
  }
  const base = { ...section, ai_findings: "", human_edited_findings: "", key_findings: { items: [], items_hidden: [] } };
  if (!web || !Array.isArray(web.findings)) return base;
  const findings = (web.findings as TeaserFinding[]).filter((f) => !f?.hidden && !f?.removed);
  return { ...base, section_details: { ...details, web: { ...web, findings } } };
}

/** Newest row per snapshot_kind, the one the web report reads (newestSnapshot). */
export function newestPerKind<T extends { snapshot_kind?: unknown; fetched_at?: unknown }>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const kind = String(row.snapshot_kind ?? "");
    const cur = best.get(kind);
    if (!cur || String(row.fetched_at ?? "") > String(cur.fetched_at ?? "")) best.set(kind, row);
  }
  return [...best.values()];
}

/** Total findings an outreach audit holds back across its pages (for the banner and email). */
export function teaserLockedTotal(sections: Section[]): number {
  let total = 0;
  for (const s of sections) {
    if (!(TEASER_PAGE_KEYS as readonly string[]).includes(String(s.section_key))) continue;
    const web = ((s.section_details ?? {}) as Record<string, unknown>).web as Record<string, unknown> | undefined;
    const findings = Array.isArray(web?.findings) ? (web!.findings as TeaserFinding[]) : [];
    const { kept } = teaserFindings(findings);
    total += findings.filter(live).length - kept.length;
  }
  return total;
}
