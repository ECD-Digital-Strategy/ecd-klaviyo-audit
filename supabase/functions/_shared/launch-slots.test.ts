import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { candidateDays, findSlots, formatSlot, zonedTime, type SlotRules } from "./launch-slots.ts";

const rules: SlotRules = {
  timezone: "America/New_York",
  day_start: "10:00",
  day_end: "16:00",
  minutes: 45,
  first_day: 2,
  last_day: 10,
  count: 3,
};

Deno.test("zonedTime: New York wall time to UTC, across DST", () => {
  assertEquals(zonedTime("2026-11-10", 600, "America/New_York").toISOString(), "2026-11-10T15:00:00.000Z");
  assertEquals(zonedTime("2026-07-10", 600, "America/New_York").toISOString(), "2026-07-10T14:00:00.000Z");
});

Deno.test("candidateDays: skips weekends, starts 2 business days out", () => {
  // Wednesday Nov 4 2026, midday in New York.
  const days = candidateDays(new Date("2026-11-04T17:00:00Z"), rules);
  assertEquals(days[0], "2026-11-06"); // Thu 5 is day 1, Fri 6 is day 2
  assertEquals(days[1], "2026-11-09"); // Monday
  assertEquals(days.length, 9);
});

Deno.test("findSlots: one per day, avoiding busy time, alternating morning and afternoon", () => {
  const now = new Date("2026-11-04T17:00:00Z");
  const busy = [
    // Friday Nov 6: busy all morning until 1pm ET.
    { start: "2026-11-06T15:00:00Z", end: "2026-11-06T18:00:00Z" },
    // Monday Nov 9: busy all day.
    { start: "2026-11-09T14:00:00Z", end: "2026-11-09T22:00:00Z" },
  ];
  const slots = findSlots(busy, rules, now).map((d) => formatSlot(d, rules.timezone));
  assertEquals(slots, [
    "Friday, November 6 at 1:00 PM ET",
    "Tuesday, November 10 at 3:00 PM ET",
    "Wednesday, November 11 at 10:00 AM ET",
  ]);
});

Deno.test("findSlots: nothing free gives nothing", () => {
  const busy = [{ start: "2026-11-01T00:00:00Z", end: "2026-12-01T00:00:00Z" }];
  assertEquals(findSlots(busy, rules, new Date("2026-11-04T17:00:00Z")), []);
});
