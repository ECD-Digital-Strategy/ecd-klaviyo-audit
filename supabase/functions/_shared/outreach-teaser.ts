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
      return { ...s, section_details: { ...details, web: { ...web, findings: kept, locked_findings: locked } } };
    });
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
