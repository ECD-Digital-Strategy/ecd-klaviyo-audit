// Moved from src/lib/competing-sms.test.ts when the unused src copies were deleted (2026-11-10).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isKlaviyoSmsInactive, scanHtmlForCompetingSms } from "./competing-sms-detect.ts";
import { buildCompetingSmsKeyFinding, extractRecoveryFlowRevenue, injectCompetingSmsFinding } from "./competing-sms-finding.ts";

Deno.test("detects Postscript and Attentive script markers in HTML", () => {
  const html = `
    <script src="https://sdk.postscript.io/sdk.bundle.js?shopId=123"></script>
    <iframe src="https://cdn.attn.tv/xyz"></iframe>
  `;
  const ids = scanHtmlForCompetingSms(html).map((p) => p.id);
  assert(ids.includes("postscript"));
  assert(ids.includes("attentive"));
});

Deno.test("treats Klaviyo SMS as inactive when revenue and subscribers are negligible", () => {
  assertEquals(isKlaviyoSmsInactive({ sms_revenue_30d: 0, sms_subscribed_profiles: 0, has_live_sms_named_flow: false }), true);
  assertEquals(isKlaviyoSmsInactive({ sms_revenue_30d: 120, sms_subscribed_profiles: 0, has_live_sms_named_flow: false }), false);
});

Deno.test("builds a key finding with browse/cart revenue context", () => {
  const recovery = extractRecoveryFlowRevenue([
    { flow_name: "Browse Abandonment", monthly_revenue_current: 5034 },
    { flow_name: "Abandoned Cart", monthly_revenue_current: 12000 },
  ]);
  const text = buildCompetingSmsKeyFinding([{ id: "postscript", name: "Postscript", markers: ["sdk.postscript.io"] }], recovery);
  assert(text.includes("Postscript"));
  assert(text.includes("Browse Abandonment"));
  assert(text.includes("Cart Abandonment"));
  assert(text.length <= 500);
});

Deno.test("injectCompetingSmsFinding replaces the fifth slot when full", () => {
  const next = injectCompetingSmsFinding(["a", "b", "c", "d", "e"], "**Postscript SMS is on your site but Klaviyo SMS is not**");
  assertEquals(next.length, 5);
  assert(next[4].includes("Postscript"));
  assertEquals(next[0], "a");
});
