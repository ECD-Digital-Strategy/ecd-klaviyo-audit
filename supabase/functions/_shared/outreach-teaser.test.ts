import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { teaserFindings, teaserLockedTotal, teaserSections, teaserShowCount } from "./outreach-teaser.ts";

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
