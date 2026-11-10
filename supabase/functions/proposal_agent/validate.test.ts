import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validateDraft, validateEditSet, validateQuestion } from "./validate.ts";

// The real payload from 2026-09-19, off the proposal at 2a449d2b after "Fit it
// for ~$10k to match his budget". The model wrote its own function-call markup
// inside the options string instead of emitting JSON, so options arrived as
// text and the tail of the second option was stranded as a sibling "value" key.
// The user saw: "The assistant produced an invalid ask_user payload:
// ask_user.options must have 2-4 entries".
const LEAKED_OPTIONS =
  '\n<parameter name="label">Phase 1 core under $10K</parameter>\n' +
  '<parameter name="value">Phase it: a Phase 1 core scope priced under $10K (navigation restructure, ' +
  'product filters, app audit and cleanup, premium/luxury polish, PDP cross-sell, liquidation section, ' +
  'GA access recovery), with SEO and other extras noted as a later phase quoted separately.</parameter>\n' +
  '</invoke>\n<invoke name="ask_user">\n<parameter name="label">Everything, trimmed to fit';

Deno.test("a question whose options leaked as function-call markup is recovered, not refused", () => {
  const result = validateQuestion({
    question: "How do you want to fit the work to his ~$10K ceiling?",
    options: LEAKED_OPTIONS,
    value: "Keep all the deliverables including SEO but trim depth so the total lands around $10K.",
  });
  assert(result.ok, result.ok ? "" : result.error);
  if (!result.ok) return;
  assertEquals(result.value.options.length, 2);
  assertEquals(result.value.options[0].label, "Phase 1 core under $10K");
  assertStringIncludes(result.value.options[0].value, "Phase it: a Phase 1 core scope priced under $10K");
  assertStringIncludes(result.value.options[0].value, "quoted separately.");
  // The stranded sibling key belongs to the option the markup cut short.
  assertEquals(result.value.options[1].label, "Everything, trimmed to fit");
  assertStringIncludes(result.value.options[1].value, "trim depth so the total lands around $10K");
  // No markup survives into what the user clicks.
  assert(!JSON.stringify(result.value).includes("<parameter"), "markup leaked into the question");
  assert(!JSON.stringify(result.value).includes("invoke"), "markup leaked into the question");
});

Deno.test("an ordinary question passes through untouched", () => {
  const result = validateQuestion({
    question: "Which tier fits?",
    options: [
      { label: "Tier 1", value: "Go with Tier 1 at $3,000 a month." },
      { label: "Tier 2", value: "Go with Tier 2 at $5,500 a month." },
    ],
    multi_select: true,
  });
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.value.options.length, 2);
  assertEquals(result.value.options[1].label, "Tier 2");
  assertEquals(result.value.multi_select, true);
  assertEquals(result.value.allow_other, true);
});

Deno.test("options JSON-encoded as a string are parsed", () => {
  const result = validateQuestion({
    question: "Keep SEO?",
    options: JSON.stringify([
      { label: "Keep it", value: "Keep SEO in scope." },
      { label: "Drop it", value: "Drop SEO for now." },
    ]),
  });
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.value.options.map((o) => o.label), ["Keep it", "Drop it"]);
});

Deno.test("a single option is a working question, since there is always a free-text Other", () => {
  const result = validateQuestion({
    question: "Proceed?",
    options: [{ label: "Yes, proceed", value: "Yes, proceed with that scope." }],
  });
  assert(result.ok, result.ok ? "" : result.error);
  if (!result.ok) return;
  assertEquals(result.value.options.length, 1);
});

Deno.test("an option with only an answer gets a short chip to click", () => {
  const long =
    "Phase the work so that navigation, filters, the app cleanup and the PDP cross-sell land first, " +
    "and everything else is quoted later.";
  const result = validateQuestion({ question: "Which way?", options: [{ value: long }] });
  assert(result.ok);
  if (!result.ok) return;
  assert(result.value.options[0].label.length <= 61, result.value.options[0].label);
  assert(result.value.options[0].label.endsWith("..."));
  assertEquals(result.value.options[0].value, long);
});

Deno.test("too many options are trimmed rather than refused", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ label: `Option ${i}`, value: `Answer ${i}` }));
  const result = validateQuestion({ question: "Pick one", options: many });
  assert(result.ok);
  if (!result.ok) return;
  assertEquals(result.value.options.length, 6);
});

Deno.test("unreadable options fail with a message the model can act on", () => {
  const result = validateQuestion({ question: "Pick one", options: "just some prose, no options here" });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error, "JSON array");
  // The old message blamed the count, which was never the problem.
  assert(!result.error.includes("2-4 entries"));
});

Deno.test("a question with no options at all is still refused", () => {
  const result = validateQuestion({ question: "Pick one", options: [] });
  assertEquals(result.ok, false);
  const missing = validateQuestion({ options: [{ label: "a", value: "b" }] });
  assertEquals(missing.ok, false);
});

const ITEM = { name: "Setup", description: "d", content: "c", one_time_price: 500, monthly_price: null };
const EDIT_CTX = {
  blockKeys: new Set(["b1", "b2"]),
  itemIds: new Set(["i1"]),
  contractSlugs: new Set(["msa"]),
  truncatedBlockKeys: new Set(["b2"]),
};

Deno.test("negative prices are refused in drafts, new lines and line patches", () => {
  const draft = validateDraft({
    title: "T", summary: "S", content_blocks: [{ title: "A", content: "x" }],
    line_items: [{ ...ITEM, one_time_price: -100 }],
  });
  assert(!draft.ok);
  const add = validateEditSet({ summary: "s", operations: [{ op: "add_line_item", item: { ...ITEM, monthly_price: -5 } }] }, EDIT_CTX);
  assert(!add.ok);
  const patch = validateEditSet({ summary: "s", operations: [{ op: "update_line_item", item_id: "i1", patch: { one_time_price: -1 } }] }, EDIT_CTX);
  assert(!patch.ok);
  const fine = validateEditSet({ summary: "s", operations: [{ op: "update_line_item", item_id: "i1", patch: { optional: true } }] }, EDIT_CTX);
  assert(fine.ok);
});

Deno.test("a truncated block can be renamed but its content cannot be replaced", () => {
  const replace = validateEditSet({ summary: "s", operations: [{ op: "update_block", block_key: "b2", content: "short" }] }, EDIT_CTX);
  assert(!replace.ok);
  if (!replace.ok) assertStringIncludes(replace.error, "truncated");
  const rename = validateEditSet({ summary: "s", operations: [{ op: "update_block", block_key: "b2", title: "New" }] }, EDIT_CTX);
  assert(rename.ok);
  const other = validateEditSet({ summary: "s", operations: [{ op: "update_block", block_key: "b1", content: "ok" }] }, EDIT_CTX);
  assert(other.ok);
});

Deno.test("optional must be a boolean on a line item", () => {
  const bad = validateDraft({
    title: "T", summary: "S", content_blocks: [{ title: "A", content: "x" }],
    line_items: [{ ...ITEM, optional: "yes" }],
  });
  assert(!bad.ok);
  const good = validateDraft({
    title: "T", summary: "S", content_blocks: [{ title: "A", content: "x" }],
    line_items: [{ ...ITEM, optional: true }],
  });
  assert(good.ok);
});

Deno.test("lines named Optional are saved as optional, never flipped back", () => {
  const draft = validateDraft({
    title: "T", summary: "S", content_blocks: [{ title: "A", content: "x" }],
    line_items: [{ ...ITEM, name: "Optional: AfterShip Returns Setup" }, { ...ITEM, optional: true }, { ...ITEM, name: "(Optional) X", optional: false }],
  });
  assert(draft.ok);
  if (draft.ok) assertEquals(draft.value.line_items.map((li: { optional?: boolean }) => li.optional), [true, true, true]);
  const add = validateEditSet({ summary: "s", operations: [{ op: "add_line_item", item: { ...ITEM, name: "Optional - SMS" } }] }, EDIT_CTX);
  assert(add.ok);
  if (add.ok) assertEquals(add.value.operations[0].item.optional, true);
  const rename = validateEditSet({ summary: "s", operations: [{ op: "update_line_item", item_id: "i1", patch: { name: "Optional add-on: Reviews" } }] }, EDIT_CTX);
  assert(rename.ok);
  if (rename.ok) assertEquals(rename.value.operations[0].patch.optional, true);
  const plain = validateEditSet({ summary: "s", operations: [{ op: "update_line_item", item_id: "i1", patch: { name: "Reviews" } }] }, EDIT_CTX);
  assert(plain.ok);
  if (plain.ok) assertEquals(plain.value.operations[0].patch.optional, undefined);
});
