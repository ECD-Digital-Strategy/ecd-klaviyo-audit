import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isTrustedAppOrigin, proposalEmailHtml, resolveOrigin } from "./mailer.ts";

const reqWithOrigin = (origin?: string) =>
  new Request("https://x.test/fn", { method: "POST", headers: origin ? { origin } : {} });

Deno.test("resolveOrigin keeps our own app domains and local dev", () => {
  assertEquals(resolveOrigin(reqWithOrigin("https://proposal.ecdigitalstrategy.com")), "https://proposal.ecdigitalstrategy.com");
  assertEquals(resolveOrigin(reqWithOrigin("https://docs.ecdigitalstrategy.com/")), "https://docs.ecdigitalstrategy.com");
  assertEquals(resolveOrigin(reqWithOrigin("https://audit.ecdigitalstrategy.com")), "https://audit.ecdigitalstrategy.com");
  assertEquals(isTrustedAppOrigin("http://localhost:3000"), true);
});

Deno.test("resolveOrigin falls back to APP_URL for a forged Origin", () => {
  const prev = Deno.env.get("APP_URL");
  Deno.env.set("APP_URL", "https://proposal.ecdigitalstrategy.com/");
  try {
    assertEquals(resolveOrigin(reqWithOrigin("https://evil.example")), "https://proposal.ecdigitalstrategy.com");
    assertEquals(resolveOrigin(reqWithOrigin("https://proposal.ecdigitalstrategy.com.evil.example")), "https://proposal.ecdigitalstrategy.com");
    assertEquals(resolveOrigin(reqWithOrigin("http://localhost:3000@evil.example")), "https://proposal.ecdigitalstrategy.com");
    assertEquals(resolveOrigin(reqWithOrigin()), "https://proposal.ecdigitalstrategy.com");
  } finally {
    if (prev === undefined) Deno.env.delete("APP_URL");
    else Deno.env.set("APP_URL", prev);
  }
});

Deno.test("proposalEmailHtml escapes the CTA and logo URLs", () => {
  const html = proposalEmailHtml({
    heading: "Hi",
    bodyLines: [],
    ctaLabel: "Open",
    ctaUrl: 'https://proposal.ecdigitalstrategy.com/p/1?a=1&b="><script>x</script>',
    logoUrl: 'https://proposal.ecdigitalstrategy.com/favicon.png" onerror="x',
  });
  assertEquals(html.includes("<script>"), false);
  assertEquals(html.includes('" onerror="'), false);
  assertStringIncludes(html, 'href="https://proposal.ecdigitalstrategy.com/p/1?a=1&amp;b=&quot;&gt;&lt;script&gt;');
});

Deno.test("proposalEmailHtml refuses a non-http CTA", () => {
  const html = proposalEmailHtml({ heading: "Hi", bodyLines: [], ctaLabel: "Open", ctaUrl: "javascript:alert(1)" });
  assertEquals(html.includes("javascript:"), false);
});
