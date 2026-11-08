import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isStaleSending } from "./welcome-delivery.ts";

Deno.test("isStaleSending: only 'sending' left for over 10 minutes", () => {
  const now = Date.parse("2026-11-08T12:00:00Z");
  assertEquals(isStaleSending({ status: "sending", updated_at: "2026-11-08T11:55:00Z" }, now), false);
  assertEquals(isStaleSending({ status: "sending", updated_at: "2026-11-08T11:45:00Z" }, now), true);
  assertEquals(isStaleSending({ status: "sending" }, now), true);
  assertEquals(isStaleSending({ status: "draft", updated_at: "2026-11-08T10:00:00Z" }, now), false);
  assertEquals(isStaleSending(null, now), false);
});
