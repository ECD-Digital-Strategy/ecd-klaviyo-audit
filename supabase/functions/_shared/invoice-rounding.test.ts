import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { roundLinesToTotal } from "./invoice-rounding.ts";

const cents = (xs: number[]) => xs.reduce((s, x) => s + Math.round(x * 100), 0);

Deno.test("a 10% discount over three $333.33 lines sums to the signed total", () => {
  // Subtotal 999.99, 10% off = 899.991, signed total rounds to $899.99.
  const amounts = [333.33, 333.33, 333.33].map((a) => a * 0.9);
  const out = roundLinesToTotal(amounts);
  assertEquals(cents(out), 89999);
  assertEquals(out.slice(0, 2), [300, 300]);
});

Deno.test("the remainder lands on the last line", () => {
  // A third off $100 three ways: 33.333... each, total $100 - rounded each gives $99.99.
  const amounts = [100 / 3, 100 / 3, 100 / 3];
  const out = roundLinesToTotal(amounts, 100);
  assertEquals(out, [33.33, 33.33, 33.34]);
  assertEquals(cents(out), 10000);
});

Deno.test("an explicit total wins and whole amounts pass through untouched", () => {
  assertEquals(roundLinesToTotal([5000, 2500]), [5000, 2500]);
  // 10.004 + 20.004 = 30.008, which is $30.01: one cent more than the lines rounded alone.
  assertEquals(roundLinesToTotal([10.004, 20.004]), [10, 20.01]);
  assertEquals(roundLinesToTotal([10.004, 20.004], 30), [10, 20]);
});

Deno.test("a remainder that would zero the last line goes on the one before", () => {
  assertEquals(roundLinesToTotal([10, 0.01], 9.99), [9.98, 0.01]);
});

Deno.test("no lines is no lines", () => {
  assertEquals(roundLinesToTotal([]), []);
});
