import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { pickClientContact } from "./invoice-delivery.ts";

Deno.test("pickClientContact: recipient, else the signer, else the client record", () => {
  const signer = { name: "Veronika L", email: "v@shop.com" };
  assertEquals(pickClientContact({ name: "Sam Lee", email: " sam@acme.com " }, signer, "info@acme.com"), { email: "sam@acme.com", name: "Sam Lee" });
  // Shared by link: no recipient email on the proposal.
  assertEquals(pickClientContact({ name: "", email: "" }, signer, "info@shop.com"), { email: "v@shop.com", name: "Veronika L" });
  assertEquals(pickClientContact({ name: "Sam", email: null }, null, "info@acme.com"), { email: "info@acme.com", name: "Sam" });
  assertEquals(pickClientContact({ name: "Sam", email: "not an email" }, { name: "x", email: "" }, null), { email: "", name: "Sam" });
});
