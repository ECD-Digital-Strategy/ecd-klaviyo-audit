import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { stripHiddenWebRows } from "./strip-hidden.ts";

Deno.test("hidden roadmap rows and hidden plays are dropped", () => {
  const section = {
    section_key: "roadmap",
    section_details: {
      web_roadmap: { hourly_rate: 150, rows: [{ item_name: "A" }, { item_name: "Secret", hidden: true }] },
      web_analytics: {
        timeframe_key: "30d",
        plays: [{ title: "Keep" }, { title: "Hide me", hidden: true }],
        metrics: [{ key: "aov", commentary: "old" }],
      },
    },
  };
  const out = stripHiddenWebRows(section) as typeof section;
  assertEquals(out.section_details.web_roadmap.rows, [{ item_name: "A" }]);
  assertEquals(out.section_details.web_roadmap.hourly_rate, 150);
  assertEquals(out.section_details.web_analytics.plays, [{ title: "Keep" }]);
  assertEquals(out.section_details.web_analytics.metrics, []);
  assertEquals(JSON.stringify(out).includes("Secret") || JSON.stringify(out).includes("Hide me"), false);
});

Deno.test("all plays hidden does not bring back the legacy metrics", () => {
  const out = stripHiddenWebRows({
    section_details: { web_analytics: { plays: [{ title: "x", hidden: true }], metrics: [{ key: "k", commentary: "c" }] } },
  }) as { section_details: { web_analytics: { plays: unknown[]; metrics: unknown[] } } };
  assertEquals(out.section_details.web_analytics.plays, []);
  assertEquals(out.section_details.web_analytics.metrics, []);
});

Deno.test("sections with nothing hidden come back unchanged", () => {
  const section = { section_details: { web_roadmap: { rows: [{ item_name: "A" }] }, web: { findings: [] } } };
  assertEquals(stripHiddenWebRows(section), section);
  const empty = { section_details: null };
  assertEquals(stripHiddenWebRows(empty), empty);
});
