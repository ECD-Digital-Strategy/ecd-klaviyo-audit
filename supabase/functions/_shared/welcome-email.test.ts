import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { DEFAULT_WELCOME, fillSubject, fillWelcome, mergeWelcome, welcomeHtml, type WelcomeVars } from "./welcome-email.ts";

const vars: WelcomeVars = {
  first_name: "Sam",
  company: "Acme",
  proposal_title: "Klaviyo implementation",
  invoice_number: "INV-1234",
  total: "$5,000.00",
  due_date: "November 18, 2026",
  pay_link: "https://in.xero.com/abc",
  sender_first_name: "Xiomara",
  intro: "",
  ecd_onboarding_form: "https://form.asana.com/x",
  w9_link: "https://drive.google.com/w9",
  client_onboarding_form: "https://docs.google.com/spreadsheets/d/intake",
};

Deno.test("fillWelcome: everything there", () => {
  const out = fillWelcome(DEFAULT_WELCOME.new_body, vars, ["Friday, November 6 at 1:00 PM ET", "Tuesday, November 10 at 3:00 PM ET"]);
  assert(out.startsWith("Hi Sam,\n\nThanks so much for signing!"), out); // no intro paragraph
  assert(out.includes("Here's the invoice ($5,000.00, due November 18, 2026): https://in.xero.com/abc"));
  assert(out.includes("- Your intake form, for access and brand assets: https://docs.google.com/spreadsheets/d/intake"));
  assert(out.includes("would any of these work for you?\n- Friday, November 6 at 1:00 PM ET\n- Tuesday, November 10 at 3:00 PM ET\nIf none"));
  assert(!out.includes("{"));
});

Deno.test("fillWelcome: missing pieces drop their lines and empty paragraphs", () => {
  const out = fillWelcome(DEFAULT_WELCOME.new_body, { ...vars, pay_link: "", client_onboarding_form: "", intro: "I'm Xiomara." }, []);
  assert(out.includes("Hi Sam,\n\nI'm Xiomara.\n\nThanks"), out);
  assert(!out.includes("invoice ("));
  assert(!out.includes("intake form"));
  assert(out.includes("- Our W-9"));
  // No times: the launch call paragraph goes entirely.
  assert(!out.includes("launch call"));
  assert(!out.includes("If none of them suit"));
});

Deno.test("fillWelcome: unknown placeholders stay visible", () => {
  assertEquals(fillWelcome("Hi {frist_name}", vars, []), "Hi {frist_name}");
});

Deno.test("fillSubject tidies gaps", () => {
  assertEquals(fillSubject("Welcome to ECD Digital Strategy, {first_name}: next steps", { ...vars, first_name: "" }), "Welcome to ECD Digital Strategy: next steps");
});

Deno.test("welcomeHtml: labelled links, bullets, escaping", () => {
  const html = welcomeHtml("Pay: https://in.xero.com/abc\n- Form: https://form.asana.com/x\nA <b> & https://other.com/p", {
    "https://in.xero.com/abc": "View and pay the invoice",
    "https://form.asana.com/x": "Fill in the onboarding form",
  });
  assert(html.includes('<a href="https://in.xero.com/abc">View and pay the invoice</a>'));
  assert(html.includes("&bull;&nbsp;Form: <a href=\"https://form.asana.com/x\">Fill in the onboarding form</a>"));
  assert(html.includes("A &lt;b&gt; &amp; <a href=\"https://other.com/p\">https://other.com/p</a>"));
});

Deno.test("mergeWelcome: off by default, bounds", () => {
  const w = mergeWelcome({ enabled: "yes", call_first_day: 5, call_last_day: 2, call_count: 50 });
  assertEquals(w.enabled, false);
  assertEquals(w.call_last_day, 5);
  assertEquals(w.call_count, 6);
  assertEquals(w.call_include_rs, true);
});
