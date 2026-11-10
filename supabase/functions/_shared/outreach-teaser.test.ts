import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  HIDDEN_ITEM_PLACEHOLDER,
  newestPerKind,
  redactExecutiveSummary,
  redactKeyFindings,
  redactKlaviyoSection,
  redactLayout,
  redactWebSection,
  teaserFindings,
  teaserLockedTotal,
  teaserSections,
  teaserShowCount,
} from "./outreach-teaser.ts";

// What the report does with key_findings (src/lib/section-key-findings.ts, since
// 2026-11-10: stored positions, no merging), reduced to the visible strings, so a
// test can prove redaction changes nothing shown.
function visibleKeyFindings(kf: unknown): string[] {
  const o = (kf ?? {}) as { items?: string[]; items_hidden?: boolean[] };
  const items = o.items ?? [];
  if (!items.some((i) => i.trim())) return [];
  return items.filter((t, i) => !(o.items_hidden ?? [])[i] && t.trim());
}

Deno.test("redactKeyFindings: hidden text is gone, visible output is unchanged", () => {
  const kf = {
    items: ["First finding.", "Secret **one** thing", "continued here, after a split.", "Third finding."],
    items_hidden: [false, true, false, false],
  };
  const before = visibleKeyFindings(kf);
  const out = redactKeyFindings(kf) as { items: string[]; items_hidden: boolean[] };
  assertEquals(JSON.stringify(out).includes("Secret"), false);
  assertEquals(out.items[1], HIDDEN_ITEM_PLACEHOLDER);
  assertEquals(out.items.length, 4); // positions kept, so the flags still line up
  assertEquals(visibleKeyFindings(out), before);
  assertEquals(before, ["First finding.", "continued here, after a split.", "Third finding."]);
});

Deno.test("redactKeyFindings: nothing hidden comes back untouched", () => {
  const kf = { items: ["a"], items_hidden: [false] };
  assertEquals(redactKeyFindings(kf), kf);
});

Deno.test("redactKeyFindings: all hidden still has items, so no legacy fallback appears", () => {
  const out = redactKeyFindings({ items: ["x.", "y."], items_hidden: [true, true] }) as { items: string[] };
  assertEquals(out.items, [HIDDEN_ITEM_PLACEHOLDER, HIDDEN_ITEM_PLACEHOLDER]);
  assertEquals(visibleKeyFindings(out), []);
});

Deno.test("redactExecutiveSummary strips hidden findings, strengths and phases", () => {
  const exec = JSON.stringify({
    text: "Summary",
    findings: ["Keep me.", "Hide me.", "Keep too."],
    findingsHidden: [false, true, false],
    concerns: ["internal concern"],
    strengths: ["s1", "secret strength"],
    strengthsHidden: [false, true],
    timeline: [{ phase: "P1", timeframe: "t", label: "l", items: ["a"] }, { phase: "P2", timeframe: "t", label: "secret", items: ["b"] }],
    timelineHidden: [false, true],
  });
  const out = JSON.parse(redactExecutiveSummary(exec) as string);
  assertEquals(out.text, "Summary");
  assertEquals(out.findings, ["Keep me.", HIDDEN_ITEM_PLACEHOLDER, "Keep too."]);
  assertEquals(out.findingsHidden, [false, true, false]);
  assertEquals(out.concerns, []);
  assertEquals(out.strengths, ["s1", ""]);
  assertEquals(out.timeline.length, 2);
  assertEquals(out.timeline[1], { phase: "", timeframe: "", label: "", items: [] });
  assertEquals(out.timeline[0].phase, "P1");
});

Deno.test("redactExecutiveSummary leaves plain text and unhidden payloads alone", () => {
  assertEquals(redactExecutiveSummary("Just text"), "Just text");
  const plain = JSON.stringify({ text: "t", findings: ["a"], findingsHidden: [false] });
  assertEquals(redactExecutiveSummary(plain), plain);
});

Deno.test("redactLayout masks hidden layout key findings", () => {
  const out = redactLayout({
    deliverability_snapshot: { key_findings: { items: ["ok.", "secret."], items_hidden: [false, true] } },
    other: 1,
  }) as Record<string, any>;
  assertEquals(out.deliverability_snapshot.key_findings.items, ["ok.", HIDDEN_ITEM_PLACEHOLDER]);
  assertEquals(out.other, 1);
});

Deno.test("redactKlaviyoSection blanks a hidden section but keeps its config and revenue", () => {
  const s = {
    section_key: "flows",
    section_config: { flows: { hidden: true } },
    summary_text: "secret",
    current_state_notes: "secret",
    revenue_opportunity: 1200,
    annotations: [{ label: "secret" }],
  };
  const out = redactKlaviyoSection(s) as Record<string, unknown>;
  assertEquals(JSON.stringify(out).includes("secret"), false);
  assertEquals(out.revenue_opportunity, 1200);
  assertEquals(out.section_config, { flows: { hidden: true } });
});

Deno.test("redactKlaviyoSection drops unread copies but keeps visible ones", () => {
  const out = redactKlaviyoSection({
    section_key: "flows",
    section_config: null,
    ai_findings: "raw ai",
    human_edited_findings: "legacy",
    summary_text: "summary",
    current_state_notes: "notes",
    key_findings: { items: ["a."], items_hidden: [false] },
  }) as Record<string, unknown>;
  assertEquals(out.ai_findings, "");
  assertEquals(out.human_edited_findings, "");
  assertEquals(out.summary_text, "summary");
  assertEquals(out.current_state_notes, "notes");
});

Deno.test("redactWebSection drops hidden and removed findings, and hidden sections keep only the locked count", () => {
  const page = redactWebSection({
    section_key: "web_homepage",
    section_config: {},
    section_details: { web: { findings: [{ text: "shown" }, { text: "h", hidden: true }, { text: "r", removed: true }] } },
  });
  assertEquals((page.section_details as any).web.findings.map((f: { text: string }) => f.text), ["shown"]);

  const hidden = redactWebSection({
    section_key: "web_cart",
    section_config: { web_cart: { hidden: true } },
    summary_text: "secret",
    section_details: { web: { findings: [{ text: "secret" }], locked_findings: { desktop: 2, mobile: 1 } } },
  });
  assertEquals(JSON.stringify(hidden).includes("secret"), false);
  assertEquals(hidden.section_details as unknown, { web: { locked_findings: { desktop: 2, mobile: 1 } } });
});

Deno.test("newestPerKind keeps the newest row of each kind", () => {
  const rows = [
    { snapshot_kind: "orders_rollup", fetched_at: "2026-01-02", id: "new" },
    { snapshot_kind: "orders_rollup", fetched_at: "2026-01-01", id: "old" },
    { snapshot_kind: "shop", fetched_at: "2026-01-01", id: "shop" },
  ];
  assertEquals(newestPerKind(rows).map((r) => r.id).sort(), ["new", "shop"]);
});

Deno.test("teaser page sections carry no other copy of the findings", () => {
  const out = teaserSections([{
    section_key: "web_homepage",
    key_findings: { items: ["locked secret"] },
    ai_findings: "locked secret",
    human_edited_findings: "locked secret",
    section_details: { web: { findings: [] } },
  }]);
  assertEquals(JSON.stringify(out).includes("locked secret"), false);
});

Deno.test("shows all but the two weakest, at least one", () => {
  assertEquals([0, 1, 2, 3, 4, 5, 6].map(teaserShowCount), [0, 1, 1, 1, 2, 3, 4]);
});

Deno.test("a 'both' finding kept for desktop counts toward mobile's number", () => {
  // Desktop: 4 counting the "both" one (shows 2). Mobile: 3 (shows 1), and its
  // strongest is the "both" one already kept, so mobile adds nothing.
  const findings = [
    { text: "b1", priority: "high", viewport: "both" },
    { text: "d1", priority: "high", viewport: "desktop" },
    { text: "d2", priority: "medium", viewport: "desktop" },
    { text: "d3", priority: "low", viewport: "desktop" },
    { text: "m1", priority: "medium", viewport: "mobile" },
    { text: "m2", priority: "low", viewport: "mobile" },
  ];
  const { kept, locked } = teaserFindings(findings);
  assertEquals(kept.map((f) => f.text), ["b1", "d1"]);
  assertEquals(locked, { desktop: 2, mobile: 2 });
});

Deno.test("4 findings on a page show 2, 5 show 3, strongest first", () => {
  const four = ["low", "high", "medium", "low"].map((priority, i) => ({ text: `f${i}`, priority, viewport: "mobile" }));
  const r4 = teaserFindings(four);
  assertEquals(r4.kept.map((f) => f.text), ["f1", "f2"]);
  assertEquals(r4.locked, { desktop: 0, mobile: 2 });
  const five = [...four, { text: "f4", priority: "high", viewport: "mobile" }];
  const r5 = teaserFindings(five);
  assertEquals(r5.kept.map((f) => f.text).sort(), ["f1", "f2", "f4"]);
  assertEquals(r5.locked, { desktop: 0, mobile: 2 });
});

Deno.test("keeps the strongest finding per screen size and counts the rest as locked", () => {
  const findings = [
    { text: "a", priority: "low", viewport: "desktop" },
    { text: "b", priority: "high", viewport: "desktop" },
    { text: "c", priority: "medium", viewport: "mobile" },
    { text: "d", priority: "high", viewport: "mobile" },
    { text: "e", priority: "medium", viewport: "both" },
  ];
  const { kept, locked } = teaserFindings(findings);
  assertEquals(kept.map((f) => f.text), ["b", "d"]);
  assertEquals(locked, { desktop: 2, mobile: 2 });
});

Deno.test("one finding for both screens is kept once and counts for each", () => {
  const { kept, locked } = teaserFindings([
    { text: "x", priority: "high", viewport: "both" },
    { text: "y", priority: "low", viewport: "desktop" },
  ]);
  assertEquals(kept.map((f) => f.text), ["x"]);
  assertEquals(locked, { desktop: 1, mobile: 0 });
});

Deno.test("hidden, removed and empty findings are neither kept nor counted", () => {
  const { kept, locked } = teaserFindings([
    { text: "shown", priority: "medium", viewport: "desktop" },
    { text: "hidden", priority: "high", viewport: "desktop", hidden: true },
    { text: "gone", priority: "high", viewport: "desktop", removed: true },
    { text: "  ", priority: "high", viewport: "desktop" },
  ]);
  assertEquals(kept.map((f) => f.text), ["shown"]);
  assertEquals(locked, { desktop: 0, mobile: 0 });
});

Deno.test("hides the roadmap and analytics, trims pages, leaves the rest alone", () => {
  const sections = [
    { section_key: "web_overview", section_details: { web: { summary: "s" } } },
    { section_key: "web_revenue_summary", section_details: {} },
    { section_key: "web_performance", section_details: {} },
    {
      section_key: "web_homepage",
      section_details: { web: { findings: [
        { text: "1", priority: "high", viewport: "desktop" },
        { text: "2", priority: "low", viewport: "desktop" },
      ] } },
    },
  ];
  const out = teaserSections(sections);
  assertEquals(out.map((s) => s.section_key), ["web_overview", "web_homepage"]);
  const web = (out[1].section_details as unknown as { web: { findings: { text: string }[]; locked_findings: unknown } }).web;
  assertEquals(web.findings.map((f) => f.text), ["1"]);
  assertEquals(web.locked_findings, { desktop: 1, mobile: 0 });
  assertEquals(teaserLockedTotal(sections), 1);
});
