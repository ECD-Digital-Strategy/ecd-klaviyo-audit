import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AI_STEP_MAX_ATTEMPTS,
  attemptCapReached,
  attemptsForStep,
  carryHiddenFlags,
  classifyStepFailure,
  decideStepFailure,
  isRunningClaimStale,
  orderFlowIdsForReport,
  parseRetryAfterMs,
  PROFILE_SCAN_HEARTBEAT_MS,
  PROFILE_SCAN_STALE_MS,
  reportingClaimIsLive,
  retryDelayMs,
  rollupFlowReportRows,
} from "./klaviyo-audit-logic.ts";
import { summarizeCampaigns } from "../ai_analyze_audit/prompts.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

// --- stale claim threshold ---------------------------------------------------

Deno.test("a scan chunk still inside its 148s budget is never stale", () => {
  assertEquals(isRunningClaimStale(ago(148_000), NOW), false);
  assertEquals(isRunningClaimStale(ago(90_000), NOW), false);
});

Deno.test("a running scan untouched for 180s is stale", () => {
  assertEquals(isRunningClaimStale(ago(180_000), NOW), true);
  assertEquals(isRunningClaimStale(ago(10 * 60_000), NOW), true);
});

Deno.test("the stale threshold leaves room for many heartbeats", () => {
  assert(PROFILE_SCAN_STALE_MS >= 180_000);
  assert(PROFILE_SCAN_STALE_MS >= PROFILE_SCAN_HEARTBEAT_MS * 5);
});

Deno.test("a row with no usable timestamp counts as stale", () => {
  assertEquals(isRunningClaimStale(null, NOW), true);
  assertEquals(isRunningClaimStale("not a date", NOW), true);
});

Deno.test("a reporting claim is live for 10 minutes", () => {
  assertEquals(reportingClaimIsLive(ago(2 * 60_000), NOW), true);
  assertEquals(reportingClaimIsLive(ago(11 * 60_000), NOW), false);
  assertEquals(reportingClaimIsLive(null, NOW), false);
});

// --- attempt cap -------------------------------------------------------------

Deno.test("timeouts retry until the third attempt, then fail", () => {
  assertEquals(decideStepFailure("timeout", 0), { action: "retry", attempts: 1, cap: AI_STEP_MAX_ATTEMPTS });
  assertEquals(decideStepFailure("timeout", 1).action, "retry");
  assertEquals(decideStepFailure("timeout", 2), { action: "fail", attempts: 3, cap: AI_STEP_MAX_ATTEMPTS });
});

Deno.test("a validation failure is retried exactly once", () => {
  assertEquals(decideStepFailure("validation", 0).action, "retry");
  assertEquals(decideStepFailure("validation", 1).action, "fail");
});

Deno.test("a permanent error fails at once", () => {
  assertEquals(decideStepFailure("permanent", 0).action, "fail");
});

Deno.test("failures are classified from the code first, then the message", () => {
  assertEquals(classifyStepFailure("AI output validation failed", "validation_failed"), "validation");
  assertEquals(classifyStepFailure("top-level: AI call timed out", "timeout"), "timeout");
  assertEquals(classifyStepFailure("OpenAI request timed out", "provider_timeout"), "timeout");
  assertEquals(classifyStepFailure("AI request failed (546)", null), "timeout");
  assertEquals(classifyStepFailure("Rate limit reached (status 429)", "provider_error"), "transient");
  assertEquals(classifyStepFailure("Failed to send a request to the Edge Function", null), "transient");
  assertEquals(classifyStepFailure("refine baseline missing sections: flows", "bad_request"), "permanent");
});

Deno.test("attempts are counted per step", () => {
  const partial = { stepAttempts: { step: 2, count: 2 } };
  assertEquals(attemptsForStep(partial, 2), 2);
  assertEquals(attemptsForStep(partial, 3), 0);
  assertEquals(attemptsForStep({}, 0), 0);
  assertEquals(attemptsForStep(null, 0), 0);
});

Deno.test("only a capped failure blocks automatic revival", () => {
  assertEquals(attemptCapReached({ attemptCapReached: true }), true);
  assertEquals(attemptCapReached({ stepAttempts: { step: 1, count: 1 } }), false);
});

// --- flow metric rollup ------------------------------------------------------

Deno.test("open and click rates come from email rows only", () => {
  const rows = [
    {
      groupings: { flow_id: "F1", flow_message_id: "m1", send_channel: "email" },
      statistics: { recipients: 100, open_rate: 0.5, click_rate: 0.1, conversion_rate: 0.02, conversion_value: 500, revenue_per_recipient: 5 },
    },
    {
      groupings: { flow_id: "F1", flow_message_id: "s1", send_channel: "sms" },
      statistics: { recipients: 100, open_rate: 0, click_rate: 0.2, conversion_rate: 0.04, conversion_value: 300, revenue_per_recipient: 3 },
    },
  ];
  const out = rollupFlowReportRows(rows)["F1"];
  assertEquals(out.recipients, 200);
  assertEquals(out.emailRecipients, 100);
  assertEquals(out.openRate, 0.5); // not 0.25, which the SMS rows used to cause
  assertEquals(out.clickRate, 0.1);
  assertEquals(out.convRate, 0.03); // all channels
  assertEquals(out.value, 800);
  assertEquals(out.rpr, 4);
  assertEquals(out.emailMessageCount, 1); // the SMS message is not counted
});

Deno.test("an SMS-only flow has no open rate and no email messages", () => {
  const out = rollupFlowReportRows([
    { groupings: { flow_id: "S", flow_message_id: "s1", send_channel: "sms" }, statistics: { recipients: 40, conversion_value: 10 } },
  ])["S"];
  assertEquals(out.openRate, null);
  assertEquals(out.clickRate, null);
  assertEquals(out.emailMessageCount, null);
  assertEquals(out.value, 10);
});

Deno.test("rows without a send_channel grouping are treated as email", () => {
  const out = rollupFlowReportRows([
    { groupings: { flow_id: "L", flow_message_id: "m1" }, statistics: { recipients: 10, open_rate: 0.4 } },
    { groupings: { flow_id: "L", flow_message_id: "m2" }, statistics: { recipients: 30, open_rate: 0.6 } },
  ])["L"];
  assertEquals(out.openRate, 0.55);
  assertEquals(out.emailMessageCount, 2);
});

Deno.test("rows without a flow id are ignored", () => {
  assertEquals(Object.keys(rollupFlowReportRows([{ groupings: {}, statistics: { recipients: 5 } }, null])), []);
});

Deno.test("live flows are reported first when the id list is capped", () => {
  const rows = [
    { flow_id: "d1", status: "draft" },
    { flow_id: "l1", status: "live" },
    { flow_id: "m1", status: "manual" },
    { flow_id: "l2", status: "Live" },
  ];
  assertEquals(orderFlowIdsForReport(rows, 3), ["l1", "l2", "m1"]);
});

// --- Klaviyo retry pacing ----------------------------------------------------

Deno.test("Retry-After is honoured in seconds and as a date, and capped", () => {
  assertEquals(parseRetryAfterMs("7", NOW), 7000);
  assertEquals(parseRetryAfterMs(new Date(NOW + 3000).toUTCString(), NOW), 3000);
  assertEquals(parseRetryAfterMs(null, NOW), null);
  assertEquals(retryDelayMs(1, 7000), 7000);
  assertEquals(retryDelayMs(1, null), 400);
  assertEquals(retryDelayMs(1, 120_000), 30_000);
});

// --- hidden flags ------------------------------------------------------------

Deno.test("an unchanged item keeps its hidden flag after a regeneration", () => {
  assertEquals(carryHiddenFlags(["a", "b", "c"], [false, true, false], ["x", "b", "a"]), [false, true, false]);
});

Deno.test("flags carry by position when nothing matches but the count does", () => {
  assertEquals(carryHiddenFlags(["a", "b"], [true, false], ["x", "y"]), [true, false]);
});

Deno.test("no stored flags means nothing is hidden", () => {
  assertEquals(carryHiddenFlags(["a"], undefined, ["a", "b"]), [false, false]);
});

// --- campaign summary totals -------------------------------------------------

Deno.test("campaign totals count the whole inventory, not the recent slice", () => {
  const campaigns = Array.from({ length: 45 }, (_, i) => ({
    name: `C${i}`,
    status: i % 3 === 0 ? "Draft" : "Sent",
    updated_at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
  }));
  const out = summarizeCampaigns(campaigns, false);
  assert(out.includes("Total campaigns: 45"), out);
  assert(out.includes("sent: 30"), out);
  assert(out.includes("draft: 15"), out);
});

Deno.test("recent campaigns are the newest by send time, then updated", () => {
  const campaigns = [
    { name: "Old", status: "Sent", updated_at: "2026-01-01T00:00:00Z" },
    { name: "Newest", status: "Sent", send_time: "2026-10-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
    { name: "Middle", status: "Sent", updated_at: "2026-06-01T00:00:00Z" },
  ];
  const recentLine = summarizeCampaigns(campaigns, false, 2).split("\n").find((l) => l.startsWith("Recent"))!;
  assert(recentLine.includes("Newest (Sent), Middle (Sent)"), recentLine);
  assert(!recentLine.includes("Old"), recentLine);
});

Deno.test("a truncated inventory says 500+", () => {
  assert(summarizeCampaigns([{ name: "a", status: "Sent" }], true).startsWith("Total campaigns: 500+"));
});
