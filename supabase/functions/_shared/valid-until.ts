// One expiry clock for proposals and documents. valid_until is a DATE and ECD bills from New York, so a link
// stays valid to the end of that day in New York and expires at the following midnight there, the same rule as
// the hourly SQL job mark_expired_proposals_lost. Keep in step with src/lib/valid-until.ts
// (the frontend cannot import from edge functions, so the same small code lives in both places).

export const BUSINESS_TIME_ZONE = "America/New_York";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(value: string): [number, number, number] | null {
  const m = DATE_RE.exec(value.slice(0, 10));
  if (!m) return null;
  const parts: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return check.getUTCMonth() === parts[1] - 1 ? parts : null;
}

/** Minutes the zone is ahead of UTC at that instant (New York: -300 or -240). */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** YYYY-MM-DD plus n calendar days. */
export function addDaysToDate(date: string, days: number): string {
  const p = parseDate(date);
  if (!p) throw new Error(`Not a date: ${date}`);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days)).toISOString().slice(0, 10);
}

/** Today's date in New York, as YYYY-MM-DD. */
export function businessDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The moment a valid_until date runs out: midnight in New York at the start of the next day. */
export function validUntilCutoff(validUntil: string | null | undefined): Date | null {
  if (!validUntil) return null;
  const p = parseDate(validUntil);
  if (!p) return null;
  const naive = Date.UTC(p[0], p[1] - 1, p[2] + 1);
  // Two passes so the offset is the one in force at the cutoff itself (DST changes at 2am, never at midnight).
  let ts = naive - zoneOffsetMinutes(new Date(naive), BUSINESS_TIME_ZONE) * 60000;
  ts = naive - zoneOffsetMinutes(new Date(ts), BUSINESS_TIME_ZONE) * 60000;
  return new Date(ts);
}

/** True once the valid_until day is over in New York. */
export function isPastValidUntil(validUntil: string | null | undefined, now: Date = new Date()): boolean {
  const cutoff = validUntilCutoff(validUntil);
  return cutoff != null && cutoff.getTime() <= now.getTime();
}

/** Whole calendar days from one YYYY-MM-DD date to another. */
export function dateDiffDays(from: string, to: string): number {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return 0;
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}
