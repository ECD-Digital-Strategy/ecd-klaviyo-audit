import { assertEquals } from "jsr:@std/assert@1";
import { sloppyPhrases, wordCount } from "./outreach-voice.ts";

Deno.test("sloppyPhrases: a plain, specific email is clean", () => {
  const email = `Hi Sam,

Your mobile product page puts "Add to cart" under four paragraphs of copy, so on a phone the button sits below the fold.

Moving it up next to the price would fix it. I wrote up two more on the cart. Want me to send them over?

Emil`;
  assertEquals(sloppyPhrases(email), []);
});

Deno.test("sloppyPhrases: catches the usual tells", () => {
  const found = sloppyPhrases("I hope this finds you well! I came across your amazing brand and I'm reaching out to help you boost conversions. Just following up — quick question.");
  for (const label of ["\"I hope this finds you well\" style opener", "\"I came across your brand\"", "\"reaching out\"", "flattery", "a vague growth promise", "a \"just following up\" line", "an em or en dash", "\"quick question\"", "an exclamation mark"]) {
    assertEquals(found.includes(label), true, label);
  }
});

Deno.test("sloppyPhrases: ordinary words that only look close pass", () => {
  assertEquals(sloppyPhrases("The drive to the checkout takes three clicks; your reviews widget loads late."), []);
});

Deno.test("wordCount", () => {
  assertEquals(wordCount("  one two\nthree  "), 3);
});
