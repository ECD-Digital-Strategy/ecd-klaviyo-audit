import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { addDaysToDate, businessDate, isPastValidUntil, validUntilCutoff } from "./valid-until.ts";

// Same cases as src/lib/valid-until.test.ts.
Deno.test("valid_until cuts off at midnight New York after the day (EDT and EST)", () => {
  assertEquals(validUntilCutoff("2026-08-01")?.toISOString(), "2026-08-02T04:00:00.000Z");
  assertEquals(validUntilCutoff("2026-12-01")?.toISOString(), "2026-12-02T05:00:00.000Z");
});

Deno.test("valid_until handles the DST change days", () => {
  assertEquals(validUntilCutoff("2026-03-07")?.toISOString(), "2026-03-08T05:00:00.000Z");
  assertEquals(validUntilCutoff("2026-03-08")?.toISOString(), "2026-03-09T04:00:00.000Z");
  assertEquals(validUntilCutoff("2026-10-31")?.toISOString(), "2026-11-01T04:00:00.000Z");
  assertEquals(validUntilCutoff("2026-11-01")?.toISOString(), "2026-11-02T05:00:00.000Z");
});

Deno.test("valid_until is valid all of the last New York day and expired from midnight", () => {
  assertEquals(isPastValidUntil("2026-08-01", new Date("2026-08-01T23:59:00-04:00")), false);
  assertEquals(isPastValidUntil("2026-08-01", new Date("2026-08-02T02:00:00+02:00")), false);
  assertEquals(isPastValidUntil("2026-08-01", new Date("2026-08-02T00:00:00-04:00")), true);
  assertEquals(isPastValidUntil(null), false);
  assertEquals(isPastValidUntil("junk"), false);
});

Deno.test("businessDate is the New York date; addDaysToDate is calendar days", () => {
  assertEquals(businessDate(new Date("2026-08-02T03:00:00Z")), "2026-08-01");
  assertEquals(businessDate(new Date("2026-08-02T05:00:00Z")), "2026-08-02");
  assertEquals(addDaysToDate("2026-08-01", 30), "2026-08-31");
  assertEquals(addDaysToDate("2026-12-31", 1), "2027-01-01");
});
