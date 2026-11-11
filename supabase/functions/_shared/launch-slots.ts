// Launch call times for the welcome email (Xiomara, 2026-11-03: "I always check
// Isa's cal and the assigned RS's one too"; RS is now LS, Lifecycle Strategist, 2026-11-11). Given everyone's busy times (Google
// Calendar free/busy), finds a few times they are all free, in working hours in one
// time zone, a couple of business days out so the team has time to prepare.
// Plain logic, no I/O: welcome-delivery.ts reads the calendars.

export type Busy = { start: string; end: string };

export type SlotRules = {
  /** IANA zone the hours are in, and the times are written in. */
  timezone: string;
  /** "10:00" to "16:00": the call has to start and end inside these. */
  day_start: string;
  day_end: string;
  minutes: number;
  /** Business days from today: the first and last day a call may be on. */
  first_day: number;
  last_day: number;
  /** How many times to offer, each on its own day. */
  count: number;
};

/** How far a zone is ahead of UTC at a moment, in ms (DST aware). */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - Math.floor(at.getTime() / 1000) * 1000;
}

/** The moment it is `minutes` past midnight on a yyyy-mm-dd day in a zone. */
export function zonedTime(ymd: string, minutes: number, tz: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d, 0, minutes);
  const first = tzOffsetMs(new Date(asUtc), tz);
  let t = asUtc - first;
  const second = tzOffsetMs(new Date(t), tz);
  if (second !== first) t = asUtc - second;
  return new Date(t);
}

/** yyyy-mm-dd of a moment in a zone. */
export function localDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
const isWeekday = (ymd: string) => weekday(ymd) !== 0 && weekday(ymd) !== 6;

/** "10:30" as minutes past midnight (bad input falls back). */
export function clock(v: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return fallback;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins <= 24 * 60 ? mins : fallback;
}

/** The business days a call may be on, from today in the zone. */
export function candidateDays(now: Date, rules: Pick<SlotRules, "timezone" | "first_day" | "last_day">): string[] {
  const out: string[] = [];
  let day = localDate(now, rules.timezone);
  let n = 0;
  while (n < rules.last_day) {
    day = addDays(day, 1);
    if (!isWeekday(day)) continue;
    n++;
    if (n >= rules.first_day) out.push(day);
  }
  return out;
}

const overlaps = (s: number, e: number, busy: Array<[number, number]>) => busy.some(([bs, be]) => s < be && e > bs);

/**
 * Times everyone is free: one per day, alternating morning and afternoon so the
 * client has a real choice. Starts on the half hour.
 */
export function findSlots(busyList: Busy[], rules: SlotRules, now: Date): Date[] {
  const busy = busyList
    .map((b) => [Date.parse(b.start), Date.parse(b.end)] as [number, number])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e));
  const startMin = clock(rules.day_start, 600);
  const endMin = clock(rules.day_end, 960);
  const len = Math.max(15, rules.minutes);
  const picked: Date[] = [];
  for (const day of candidateDays(now, rules)) {
    if (picked.length >= rules.count) break;
    const free: Date[] = [];
    for (let m = startMin; m + len <= endMin; m += 30) {
      const s = zonedTime(day, m, rules.timezone);
      const e = s.getTime() + len * 60_000;
      if (s.getTime() > now.getTime() && !overlaps(s.getTime(), e, busy)) free.push(s);
    }
    if (!free.length) continue;
    // Even picks take the earliest free time, odd ones the latest.
    picked.push(picked.length % 2 === 0 ? free[0] : free[free.length - 1]);
  }
  return picked;
}

/** "ET" for New York and friends, else the zone's own short name. */
export function zoneLabel(tz: string, at: Date): string {
  const known: Record<string, string> = {
    "America/New_York": "ET",
    "America/Chicago": "CT",
    "America/Denver": "MT",
    "America/Los_Angeles": "PT",
  };
  if (known[tz]) return known[tz];
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName");
  return part?.value ?? tz;
}

/** "Tuesday, November 10 at 11:00 AM ET" */
export function formatSlot(at: Date, tz: string): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(at);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(at);
  return `${day} at ${time} ${zoneLabel(tz, at)}`;
}
