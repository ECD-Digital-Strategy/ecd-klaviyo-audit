// Which draft invoices a signed proposal becomes, and when each is dated and
// due. Zak's billing rules (Oct 19, 2026):
//
// - Implementation only: one invoice, dated and due the day they sign.
// - Retainer only: one invoice, dated and due the day they sign.
// - Both: two invoices. The implementation is due the day they sign; the
//   first month of the retainer is a draft dated and due the 1st of the next
//   month, which Maria issues when it is time.
// - Complimentary work (a line or a whole kind that nets to zero) is not
//   invoiced at all.
//
// Pure functions, no Supabase or Xero, so the rules are tested directly.

export type FeeKind = "one_time" | "monthly";

export type PlanLine = {
  kind: FeeKind;
  description: string;
  /** After the proposal discount. */
  amount: number;
  accountCode: string;
  itemCode: string | null;
};

export type PlannedInvoice = {
  kind: FeeKind;
  /** YYYY-MM-DD. */
  date: string;
  dueDate: string;
  lines: PlanLine[];
};

/** The 1st of the month after a YYYY-MM-DD date. */
export function firstOfNextMonth(date: string): string {
  const [y, m] = date.split("-").map(Number);
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return `${next.y}-${String(next.m).padStart(2, "0")}-01`;
}

/** A moment as a calendar date in New York, where ECD bills from. */
export function newYorkDate(at: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

export function planInvoices(lines: PlanLine[], signedOn: string): PlannedInvoice[] {
  const billable = lines.filter((l) => Math.round(l.amount * 100) > 0);
  const oneTime = billable.filter((l) => l.kind === "one_time");
  const monthly = billable.filter((l) => l.kind === "monthly");
  const out: PlannedInvoice[] = [];
  if (oneTime.length) out.push({ kind: "one_time", date: signedOn, dueDate: signedOn, lines: oneTime });
  if (monthly.length) {
    const date = oneTime.length ? firstOfNextMonth(signedOn) : signedOn;
    out.push({ kind: "monthly", date, dueDate: date, lines: monthly });
  }
  return out;
}
