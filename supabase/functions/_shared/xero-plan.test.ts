import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { firstOfNextMonth, newYorkDate, type PlanLine, planInvoices } from "./xero-plan.ts";
import { familyKey, resolveAccountCode } from "./xero-accounts.ts";

const line = (kind: PlanLine["kind"], amount: number): PlanLine => ({
  kind,
  description: kind,
  amount,
  accountCode: kind === "one_time" ? "4011" : "4002",
  itemCode: null,
});

Deno.test("implementation only: one invoice due the day they sign", () => {
  const plan = planInvoices([line("one_time", 6000)], "2026-10-16");
  assertEquals(plan.map((p) => [p.kind, p.date, p.dueDate]), [["one_time", "2026-10-16", "2026-10-16"]]);
});

Deno.test("retainer only: dated and due the day they sign", () => {
  const plan = planInvoices([line("monthly", 5500)], "2026-10-16");
  assertEquals(plan.map((p) => [p.kind, p.date, p.dueDate]), [["monthly", "2026-10-16", "2026-10-16"]]);
});

Deno.test("both: implementation now, first month on the 1st of next month", () => {
  const plan = planInvoices([line("one_time", 4500), line("monthly", 500)], "2026-10-15");
  assertEquals(plan.map((p) => [p.kind, p.date, p.dueDate]), [
    ["one_time", "2026-10-15", "2026-10-15"],
    ["monthly", "2026-11-01", "2026-11-01"],
  ]);
  assertEquals(firstOfNextMonth("2026-12-09"), "2027-01-01");
});

Deno.test("complimentary work is not invoiced", () => {
  assertEquals(planInvoices([line("one_time", 0), line("monthly", 3000)], "2026-09-30").map((p) => p.kind), ["monthly"]);
  assertEquals(planInvoices([line("one_time", 0)], "2026-09-30"), []);
});

Deno.test("signing date is the New York calendar day", () => {
  // 02:00 UTC on Oct 17 is still the evening of Oct 16 in New York.
  assertEquals(newYorkDate(new Date("2026-10-17T02:00:00Z")), "2026-10-16");
});

Deno.test("old categories fold into the families", () => {
  assertEquals([familyKey("klaviyo"), familyKey("sms"), familyKey("ai_agents"), familyKey("web_cro")], [
    "retention",
    "retention",
    "retention",
    "website",
  ]);
  const mapping = [{ service_key: "retention", name: "Retention", one_time_account_code: "4011", monthly_account_code: "4002" }];
  const defaults = { mrrAccountCode: null, salesAccountCode: null };
  assertEquals(resolveAccountCode({ label: "Tier 1", serviceKey: "klaviyo", kind: "monthly" }, mapping, defaults), {
    ok: true,
    accountCode: "4002",
    serviceName: "Retention",
  });
});
