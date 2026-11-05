// Run with: deno test supabase/functions/_shared/payment-terms.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { splitPaymentTerms } from "./payment-terms.ts";

const blocks = (...content: string[]) => content.map((c, i) => ({ key: `b${i}`, title: `Block ${i}`, content: c }));

Deno.test("Burton's SOW splits the fee, so its invoice is held (Nov 4)", () => {
  const burton = blocks(
    "**Scope**\n- Every audit fix across all three Klaviyo accounts",
    "**Payment terms**\n- 50% of the project fee is invoiced when this SOW is signed\n- The remaining 50% is invoiced on completion, once all three regions are live\n- Work begins once the first invoice is paid and access is granted\n- Fees are non-refundable once work has started",
  );
  assertEquals(splitPaymentTerms(burton), "50% of the project fee is invoiced when this SOW is signed");
});

Deno.test("the other ways people write a split", () => {
  for (const text of [
    "A 50% deposit is due at signing.",
    "30% upfront, 70% at launch.",
    "40% due on signing and the rest when the site goes live.",
    "The balance is due on completion.",
    "Payment schedule: see below.",
    "Billed in two installments.",
    "We split it 50/50.",
    "Half up front, half at launch.",
    "A deposit of $2,500 holds the start date.",
    "60% on kickoff, 40% on delivery.",
  ]) {
    assertEquals(typeof splitPaymentTerms(blocks(text)), "string", text);
  }
});

Deno.test("marketing copy and plain terms are not a split", () => {
  for (const text of [
    // HigherDOSE (#69) and Lija Style (#27), signed in October: "up front" in another sense, discounts.
    "Fully built and themed for Black Friday, with short copy and the code up front. 11 emails in total.",
    "Early access (Nov 3 to 22): 20% off sitewide, bundles 30 to 40%",
    "Because we know the build, we can scope these changes precisely and tell you up front what's native to your theme.",
    "Flows drive 25% of revenue for most brands.",
    "We expect a 15% lift in conversion at launch.",
    "Invoices are due upon receipt.",
    "Fees are non-refundable once work has started.",
    "Promote Shop Pay Installments on the product page.",
    "The total investment is $10,000.",
    // Lanna Lashes' Meta ads proposal (#83): an ad, not a fee.
    "One ad carrying the account: the lash lift bundle ad was copied 13 times and took 63% of the budget.",
  ]) {
    assertEquals(splitPaymentTerms(blocks(text)), null, text);
  }
});

Deno.test("nothing to read", () => {
  assertEquals(splitPaymentTerms(null), null);
  assertEquals(splitPaymentTerms([]), null);
  assertEquals(splitPaymentTerms([{ title: "x" }]), null);
});
