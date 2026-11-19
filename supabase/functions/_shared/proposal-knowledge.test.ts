import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { cleanKnowledge, knowledgePrompt } from "./proposal-knowledge.ts";

Deno.test("knowledgePrompt: only enabled entries, with rules and reference", () => {
  const entries = cleanKnowledge([
    { id: "w", title: "Email warmup", applies_when: "Any warmup", rules: "Up to 8 sends under 100K.", reference: "We email your most engaged first.", enabled: true },
    { id: "x", title: "Old thing", applies_when: "", rules: "Ignore me", enabled: false },
  ]);
  const p = knowledgePrompt(entries);
  assert(p.startsWith("AGENCY KNOWLEDGE"));
  assert(p.includes("### Email warmup") && p.includes("Up to 8 sends") && p.includes("most engaged first"));
  assert(!p.includes("Old thing"));
});

Deno.test("knowledgePrompt: nothing enabled gives nothing", () => {
  assertEquals(knowledgePrompt([]), "");
  assertEquals(knowledgePrompt(cleanKnowledge([{ title: "A", rules: "r", enabled: false }])), "");
});

Deno.test("cleanKnowledge drops entries without a title or rules, and anything that isn't a list", () => {
  assertEquals(cleanKnowledge([{ title: "", rules: "x" }, { title: "T", rules: "  " }, null]).length, 0);
  assertEquals(cleanKnowledge("nope"), []);
  assertEquals(cleanKnowledge([{ title: "T", rules: "r" }])[0].enabled, true);
});
