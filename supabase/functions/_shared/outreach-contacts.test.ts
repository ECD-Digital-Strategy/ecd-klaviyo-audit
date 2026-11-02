import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { contactScore, founderNames, isRoleAddress, rankContacts, verdictOf } from "./outreach-contacts.ts";

Deno.test("role addresses are refused, people are not", () => {
  for (const e of ["support@brand.com", "Info@brand.com", "hello+us@brand.com", "customer.service@brand.com", "no-reply@brand.com"]) {
    assertEquals(isRoleAddress(e), true, e);
  }
  for (const e of ["jane@brand.com", "jane.doe@brand.com", "jd@brand.com"]) assertEquals(isRoleAddress(e), false, e);
});

Deno.test("founders and marketing leads rank above managers; juniors and generics are dropped", () => {
  const ranked = rankContacts([
    { value: "intern@brand.com", position: "Marketing Intern", seniority: "junior", department: "marketing" },
    { value: "mm@brand.com", position: "Marketing Manager", confidence: 99 },
    { value: "help@brand.com", position: "CEO", type: "generic" },
    { value: "ecom@brand.com", position: "Director of Ecommerce", confidence: 80 },
    { value: "jane@brand.com", position: "Co-Founder & CEO", confidence: 60 },
  ]);
  assertEquals(ranked.map((e) => e.value), ["jane@brand.com", "ecom@brand.com", "mm@brand.com"]);
});

Deno.test("with no title, Hunter's seniority decides", () => {
  assertEquals(contactScore({ value: "a@b.com", seniority: "executive", department: "executive" }) > 0, true);
  assertEquals(contactScore({ value: "a@b.com", seniority: "senior", department: "it" }), 0);
});

Deno.test("verifier verdicts", () => {
  assertEquals(["valid", "accept_all", "invalid", "unknown", "webmail"].map(verdictOf), ["valid", "catch_all", "invalid", "unknown", "unknown"]);
});

Deno.test("founder names from an About page", () => {
  const text = "Our story. Brand was founded by Jane Doe in 2015. Meet the team. Sam Lee, Co-Founder, runs product.";
  assertEquals(founderNames(text), ["Jane Doe", "Sam Lee"]);
  assertEquals(founderNames("We are a team of makers."), []);
});
