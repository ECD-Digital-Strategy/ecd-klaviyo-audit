import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { impliesOptional } from "./line-optional.ts";

Deno.test("impliesOptional matches the src copy", () => {
  for (const n of ["Optional: X", "Optional - X", "(Optional) X", "Optional add-on: X", " optional X"]) {
    assertEquals(impliesOptional(n), true, n);
  }
  for (const n of ["X (optional)", "Optionality review", "Email retainer", ""]) {
    assertEquals(impliesOptional(n), false, n);
  }
});
