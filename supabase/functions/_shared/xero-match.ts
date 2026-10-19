// Code a freehand proposal line from its name. Most proposals are written by
// hand or by the assistant, so their lines link to no catalog service and
// carry no family or Item (iHome Health Fitness, Oct 19, 2026: "Klaviyo Mini
// Implementation"). The line name is matched against the catalog services and
// the Xero Items; only a clear, unique match codes it, and the draft notes it
// so Maria can check. Anything else is left for a person to pick.

export type MatchCandidate = {
  /** What is matched against the line name. */
  name: string;
  itemCode: string | null;
  /** The family, when the candidate knows it (a catalog service does). */
  family: string | null;
  /** The Item's own Xero account, to place a bare Item in a family. */
  account: string | null;
};

export type Match = { itemCode: string | null; family: string; matched: string; score: number };

// Words that say nothing about which service it is.
const NOISE = new Set(["k", "ecd", "the", "and", "for", "of", "a", "an", "to", "with", "by", "setup", "set", "up", "service", "services"]);

export function tokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/&/g, " and ")
      .split(/[^a-z0-9]+/)
      .filter((t) => t && !NOISE.has(t)),
  );
}

/** Jaccard overlap of two names' meaningful words. */
export function nameScore(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}

/** 4002/4011 Retention, 4001/4012 Website, 4003/4013 Paid ads. */
export function familyForAccount(code: string | null): string | null {
  if (!code) return null;
  if (code === "4002" || code === "4011") return "retention";
  if (code === "4001" || code === "4012") return "website";
  if (code === "4003" || code === "4013") return "paid_ads";
  return null;
}

const CLEAR = 0.75;
const MARGIN = 0.15;

/** The clear best match for a line name, or null. A tie or a near tie between
 * different Items is not clear. */
export function matchLine(lineName: string, candidates: MatchCandidate[]): Match | null {
  const scored = candidates
    .map((c) => ({ c, score: nameScore(lineName, c.name), family: c.family ?? familyForAccount(c.account) }))
    .filter((s) => s.family && s.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < CLEAR) return null;
  const rival = scored.find((s) => s.c.itemCode !== best.c.itemCode || s.family !== best.family);
  if (rival && best.score - rival.score < MARGIN) return null;
  return { itemCode: best.c.itemCode, family: best.family!, matched: best.c.name, score: best.score };
}
