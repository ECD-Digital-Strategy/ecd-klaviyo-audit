import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { moneyEmail, totalsEmailLine } from "./proposal-public.ts";

const totals = (oneTimeTotal: number, monthlyTotal: number) => ({
  oneTimeSubtotal: oneTimeTotal,
  monthlySubtotal: monthlyTotal,
  oneTimeDiscount: 0,
  monthlyDiscount: 0,
  oneTimeTotal,
  monthlyTotal,
});

Deno.test("team email totals keep cents a discount lands on", () => {
  assertEquals(moneyEmail(9975), "$9,975");
  assertEquals(moneyEmail(8977.5), "$8,977.50");
  assertEquals(totalsEmailLine(totals(899.991, 0)), "Totals: $899.99 one-time.");
  assertEquals(totalsEmailLine(totals(10000, 1500)), "Totals: $10,000 one-time plus $1,500/mo.");
});
