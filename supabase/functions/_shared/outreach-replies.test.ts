import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { quickVerdict } from "./outreach-replies.ts";

Deno.test("the obvious replies are sorted without a model", () => {
  assertEquals(quickVerdict("No.")?.kind, "not_interested");
  assertEquals(quickVerdict("no thanks")?.kind, "not_interested");
  assertEquals(quickVerdict("Unsubscribe")?.kind, "unsubscribe");
  assertEquals(quickVerdict("I'm away until Monday", "Automatic reply: Your homepage")?.kind, "out_of_office");
  assertEquals(quickVerdict("No, but send me the full audit"), null);
});
