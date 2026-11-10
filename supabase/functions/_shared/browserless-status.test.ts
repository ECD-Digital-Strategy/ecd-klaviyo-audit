// What a failed capture means for the retry policy in web_capture_screenshots.
// Run with: npx deno test -A supabase/functions/_shared/
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifyCaptureFailure, FUNCTION_CODE } from "./browserless.ts";

Deno.test("a missing page is terminal, not a bot block", () => {
  assertEquals(classifyCaptureFailure("page_missing (http 404)"), "page_missing");
  assertEquals(classifyCaptureFailure("page_missing (http 410)"), "page_missing");
});

Deno.test("a password-protected store is terminal", () => {
  assertEquals(
    classifyCaptureFailure("store_password_protected (https://shop.example.com/password)"),
    "store_password_protected",
  );
});

Deno.test("a plain server error gets the normal budget, whatever its body says", () => {
  assertEquals(classifyCaptureFailure("storefront_http_502 (Bad gateway)"), "transient");
  assertEquals(classifyCaptureFailure("storefront_http_503 (request blocked upstream)"), "transient");
  assertEquals(classifyCaptureFailure("storefront_http_500 (Unauthorized access to backend)"), "transient");
});

Deno.test("bot blocks and rate limits get the larger budget", () => {
  assertEquals(classifyCaptureFailure("storefront_blocked (http 429: Too many requests)"), "blocked");
  assertEquals(classifyCaptureFailure("storefront_blocked (final: verify you are human)"), "blocked");
  assertEquals(classifyCaptureFailure("storefront_blocked (http 503: Just a moment...)"), "blocked");
});

Deno.test("Browserless refusing the call goes straight to the fallback", () => {
  assertEquals(classifyCaptureFailure("browserless_http_402: units usage exceeded"), "hopeless");
  assertEquals(classifyCaptureFailure("browserless_http_401: unauthorized"), "hopeless");
});

Deno.test("anything else is a plain transient miss", () => {
  assertEquals(classifyCaptureFailure("browserless_timeout"), "transient");
  assertEquals(classifyCaptureFailure("browserless_blank_page"), "transient");
  assertEquals(classifyCaptureFailure(""), "transient");
});

Deno.test("the in-page script emits the codes the classifier reads", () => {
  for (const code of ["page_missing (http ", "store_password_protected (", "storefront_http_", "storefront_blocked ("]) {
    if (!FUNCTION_CODE.includes(code)) throw new Error(`injected script never emits "${code}"`);
  }
  // The password check must survive the template literal with its escapes.
  if (!FUNCTION_CODE.includes("/\\/password\\/?$/i")) throw new Error("password path regex lost its escapes");
});
