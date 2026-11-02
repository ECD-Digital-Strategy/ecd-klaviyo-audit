// Who an outreach email goes to (Emil, 2026-11-02): a decision-maker, never a
// support inbox. outreach_contacts asks Hunter for the people it knows at the
// store's domain, picks the most senior one who owns marketing or the business,
// and checks the address before it is filled in. outreach_send refuses role
// addresses (support@, info@ and the like) outright.

/** Local parts that reach a team or a ticket queue, not a person. */
const ROLE_LOCAL_PARTS = new Set([
  "support", "help", "info", "hello", "hi", "hey", "contact", "contactus", "team", "care", "customercare",
  "customerservice", "service", "orders", "order", "sales", "shop", "store", "admin", "office", "mail",
  "enquiries", "inquiries", "questions", "returns", "shipping", "billing", "accounts", "careers", "jobs",
  "press", "media", "pr", "partners", "partnerships", "wholesale", "marketing", "social", "noreply",
  "no-reply", "donotreply", "webmaster", "hr", "legal", "privacy", "feedback", "community", "ambassadors",
  "affiliates", "collabs", "influencers", "general",
]);

/** True for addresses that reach a shared inbox (support@, info@, hello+us@...). */
export function isRoleAddress(email: string): boolean {
  const local = email.trim().toLowerCase().split("@")[0]?.split("+")[0] ?? "";
  if (!local) return true;
  return ROLE_LOCAL_PARTS.has(local) || ROLE_LOCAL_PARTS.has(local.replace(/[._-]/g, ""));
}

export type HunterEmail = {
  value: string;
  type?: string | null; // "personal" | "generic"
  confidence?: number | null;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  seniority?: string | null; // "junior" | "senior" | "executive"
  department?: string | null;
  verification?: { status?: string | null } | null;
};

// Highest first. Titles beat Hunter's own seniority/department tags, which are
// often missing; a founder of a $1M+ brand usually still decides on the website.
const TITLE_RANKS: Array<[RegExp, number]> = [
  [/\b(co-?)?founder\b|\bowner\b|\bceo\b|chief executive|\bpresident\b/i, 100],
  [/\bcmo\b|chief marketing|chief growth|chief digital|chief revenue|chief commercial/i, 95],
  [/\bcoo\b|chief operating|general manager|managing director/i, 80],
  [/(vp|vice president|head|director)\b.*\b(e-?commerce|ecomm|digital|growth|marketing|dtc|d2c|brand|retention|crm|online)/i, 90],
  [/\b(e-?commerce|ecomm|digital|growth|marketing|dtc|d2c|retention|crm)\b.*\b(vp|vice president|head|director|lead)\b/i, 90],
  [/(e-?commerce|ecomm|digital|growth|retention|crm|email)\s+(manager|lead)/i, 70],
  [/marketing manager|brand manager/i, 60],
];

/** How good a person is to email: 0 means do not pick them. */
export function contactScore(e: HunterEmail): number {
  if (!e.value?.includes("@") || isRoleAddress(e.value)) return 0;
  if (String(e.type ?? "").toLowerCase() === "generic") return 0;
  const title = String(e.position ?? "");
  let score = 0;
  for (const [re, rank] of TITLE_RANKS) {
    if (re.test(title)) {
      score = rank;
      break;
    }
  }
  if (!score) {
    const seniority = String(e.seniority ?? "").toLowerCase();
    const dept = String(e.department ?? "").toLowerCase();
    if (seniority === "executive") score = dept === "executive" || dept === "management" ? 75 : 65;
    else if (seniority === "senior" && (dept === "marketing" || dept === "executive" || dept === "management")) score = 50;
    else return 0;
  }
  // A small nudge for addresses Hunter is surer of; never enough to beat a better title.
  return score + Math.min(9, Math.floor((e.confidence ?? 0) / 11));
}

/** The best people to try, best first (only the ones worth emailing). */
export function rankContacts(emails: HunterEmail[]): HunterEmail[] {
  return emails
    .map((e, i) => ({ e, i, s: contactScore(e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.e);
}

export const fullName = (e: Pick<HunterEmail, "first_name" | "last_name">) =>
  [e.first_name, e.last_name].map((s) => String(s ?? "").trim()).filter(Boolean).join(" ") || null;

/** Hunter's verifier verdict, as we use it: only "valid" is sent to without a second look. */
export type Verdict = "valid" | "catch_all" | "invalid" | "unknown";
export function verdictOf(status: string | null | undefined): Verdict {
  const s = String(status ?? "").toLowerCase();
  if (s === "valid" || s === "deliverable") return "valid";
  if (s === "accept_all" || s === "risky") return "catch_all";
  if (s === "invalid" || s === "undeliverable" || s === "disposable") return "invalid";
  return "unknown";
}

/**
 * Founder names from an About page, for stores Hunter knows no one at:
 * "founded by Jane Doe", "Jane Doe, Founder", "our founder, Jane Doe".
 * Names only (two or three capitalised words); the caller asks Hunter for the address.
 */
export function founderNames(text: string): string[] {
  const NAME = "([A-Z][a-z'’-]+(?: [A-Z][a-z'’-]+){1,2})";
  const patterns = [
    new RegExp(`(?:[Cc]o-?)?[Ff]ounded by ${NAME}`, "g"),
    new RegExp(`${NAME},? (?:our |the )?(?:[Cc]o-?)?[Ff]ounder`, "g"),
    new RegExp(`(?:[Cc]o-?)?[Ff]ounder(?: and CEO| & CEO)?,? ${NAME}`, "g"),
    new RegExp(`${NAME},? (?:our |the )?(?:CEO|owner)\\b`, "g"),
  ];
  const STOP = /^(The|Our|We|Meet|About|Hello|Shop|Brand|Team|Founder|Founded|Story)\b/;
  const out: string[] = [];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const name = m[1].trim();
      if (!STOP.test(name) && !out.includes(name)) out.push(name);
    }
  }
  return out.slice(0, 3);
}
