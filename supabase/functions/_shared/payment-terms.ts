// Payment terms written into a proposal's own text that split the one-time fee: a deposit, "50% when signed,
// 50% on completion", installments. Burton (Nov 4, 2026) signed an SOW saying "50% of the project fee is
// invoiced when this SOW is signed" and got one approved invoice for the whole $10,000, emailed the moment they
// signed (Zak flagged it). Until proposals carry payment terms as a setting, an implementation invoice for such a
// proposal is held as a draft for Maria (xero-invoice.ts) instead of being approved and sent.
//
// Reads the proposal's sections (content_blocks: [{ title, content }]), never the standard contracts. A false
// alarm only costs Maria one look at a draft; a miss sends a client the wrong bill, so the patterns lean wide.
// Pure, so it is tested directly (payment-terms.test.ts).

const PATTERNS: RegExp[] = [
  // "50% of the project fee", "30% of the total fee", "50% is invoiced", "40% due", "30% upfront", "50% deposit",
  // "50% on signing", "50% on completion". Not "20% off", "15% of revenue", "63% of the budget" (ad spend, Lanna
  // Lashes' #83) or "a 25% lift".
  /\b\d{1,3}\s?%\s+(?:of\s+(?:the\s+)?(?:total\s+|project\s+|implementation\s+|setup\s+|build\s+|one-time\s+|fixed\s+)?(?:fee|price|cost|amount|invoice)s?\b|(?:is\s+|are\s+|will\s+be\s+|to\s+be\s+)?(?:invoiced|billed|due|payable)\b|up\s?-?front\b|deposit\b|(?:on|upon|at|after|before)\s+(?:signing|signature|sign-?off|kick-?off|start|completion|launch|delivery|go-?live|handoff|hand-?off)\b)/i,
  // "a deposit", "the deposit", "deposit of", "down payment", "payment schedule", "milestone payments".
  /\b(?:(?:a|the|initial|first)\s+deposit|deposit\s+of|down\s?payment|payment\s+schedule|milestone\s+payments?)\b/i,
  // "in two installments", "split into 3 payments". Not Shop Pay Installments.
  /\b(?:in|into|over)\s+(?:two|three|four|2|3|4)\s+(?:installments|instalments|payments|invoices)\b/i,
  // "the remaining 50% ... on completion", "the balance is due at launch".
  /\b(?:remaining|balance|second\s+half|other\s+half|final\s+payment)\b[^.\n]{0,100}\b(?:on|upon|at|after)\s+(?:completion|launch|delivery|go-?live|handoff|hand-?off|sign-?off)\b/i,
  // "split 50/50", "half up front", "half now".
  /\b(?:50\s?\/\s?50|half\s+(?:up\s?-?front|now|on\s+signing|at\s+signing|when\s+signed))\b/i,
];

type Block = { title?: unknown; content?: unknown };

/** "- **Payment terms** 50% ..." -> "Payment terms 50% ...": a line as a person reads it. */
function plain(line: string): string {
  return line.replace(/^[\s>*#-]+/, "").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
}

/**
 * True when the line splits the payment. A percentage only counts when it is less than 100: "The project fee is
 * billed 100% upfront at signing" is one payment, not a split (Lanna Lashes, Nov 12, 2026: held by mistake).
 */
function splitsPayment(line: string): boolean {
  const [byPercent, ...rest] = PATTERNS;
  if (rest.some((re) => re.test(line))) return true;
  if (!byPercent.test(line)) return false;
  const percents = [...line.matchAll(/\b(\d{1,3})\s?%/g)].map((m) => Number(m[1]));
  return percents.some((p) => p > 0 && p < 100);
}

/** The first line of the proposal's own text that splits the payment, as written (max 300 chars), or null. */
export function splitPaymentTerms(contentBlocks: unknown): string | null {
  if (!Array.isArray(contentBlocks)) return null;
  for (const block of contentBlocks as Block[]) {
    const content = typeof block?.content === "string" ? block.content : "";
    for (const raw of content.split(/\n+/)) {
      const line = plain(raw);
      if (line && splitsPayment(line)) return line.slice(0, 300);
    }
  }
  return null;
}
