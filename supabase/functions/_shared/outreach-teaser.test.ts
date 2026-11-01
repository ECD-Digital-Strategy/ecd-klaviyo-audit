import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { teaserFindings, teaserLockedTotal, teaserSections } from "./outreach-teaser.ts";

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
