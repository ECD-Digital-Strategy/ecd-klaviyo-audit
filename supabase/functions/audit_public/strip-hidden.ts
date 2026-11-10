// Hidden web roadmap rows and hidden analytics plays never reach the public link.
// Safe to drop whole: the report's totals and counts already skip hidden rows
// (investmentRows, computeWebInvestmentTotals in src/lib/web-audit-pricing.ts,
// WebRoadmapTable, WebAnalyticsSection "to ship").

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

const isHidden = (v: unknown) => asRec(v)?.hidden === true;

export function stripHiddenWebRows<T extends { section_details?: unknown }>(section: T): T {
  const details = asRec(section.section_details);
  if (!details) return section;
  let next: Rec | null = null;

  const roadmap = asRec(details.web_roadmap);
  if (roadmap && Array.isArray(roadmap.rows) && roadmap.rows.some(isHidden)) {
    next = { ...(next ?? details), web_roadmap: { ...roadmap, rows: roadmap.rows.filter((r) => !isHidden(r)) } };
  }

  const analytics = asRec(details.web_analytics);
  if (analytics && Array.isArray(analytics.plays) && analytics.plays.some(isHidden)) {
    const plays = analytics.plays.filter((p) => !isHidden(p));
    // Older per-metric commentary only shows when there are no plays at all, so
    // it must not surface just because every play was hidden.
    const metrics = analytics.plays.length > 0 ? [] : analytics.metrics;
    next = { ...(next ?? details), web_analytics: { ...analytics, plays, ...(metrics !== undefined ? { metrics } : {}) } };
  }

  return next ? { ...section, section_details: next } : section;
}
