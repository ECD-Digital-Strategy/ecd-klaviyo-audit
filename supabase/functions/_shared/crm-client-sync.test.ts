import { assertEquals } from "jsr:@std/assert@1";
import { isTestRecord, planClientSync, type ExistingClient } from "./crm-client-sync.ts";
import type { CrmCompany } from "./outreach-crm.ts";

const co = (id: string, name: string | null, domain: string | null, contact: CrmCompany["contact"] = null): CrmCompany =>
  ({ id, name, domain, company_type: null, origin: "crm", contact });

const existing: ExistingClient[] = [
  { id: "c1", company_name: "Faherty", website_url: "https://fahertybrand.com", hubspot_company_id: "111" },
  { id: "c2", company_name: "Lija Style", website_url: "https://www.lijastyle.com/", hubspot_company_id: null },
  { id: "c3", company_name: "Moto Machines", website_url: "", hubspot_company_id: null },
];

Deno.test("planClientSync: linked companies are left alone; name or website matches are linked", () => {
  const p = planClientSync([co("111", "Faherty", "fahertybrand.com"), co("900", "Lija", "lijastyle.com"), co("901", "moto machines", null)], existing);
  assertEquals(p.create.length, 0);
  assertEquals(p.link, [{ clientId: "c2", companyId: "900" }, { clientId: "c3", companyId: "901" }]);
  assertEquals(p.skipped.already_linked, 1);
});

Deno.test("planClientSync: new companies become clients with their main contact, flagged crm_imported", () => {
  const p = planClientSync([co("902", "Kosas", "kosas.com", { name: "Jo Doe", email: "jo@kosas.com" })], existing);
  assertEquals(p.create.length, 1);
  assertEquals(p.create[0].company_name, "Kosas");
  assertEquals(p.create[0].website_url, "https://kosas.com");
  assertEquals(p.create[0].email, "jo@kosas.com");
  assertEquals(p.create[0].hubspot_company_id, "902");
  assertEquals(p.create[0].crm_imported, true);
  assertEquals(p.create[0].notes, "Imported from Revenue Desk");
});

Deno.test("planClientSync: no name and test records are skipped; duplicates in one run are created once", () => {
  const p = planClientSync([
    co("903", null, "x.com"),
    co("904", "ZZ Booking Test Co", "zz-booking-test-1c4fd3.com"),
    co("905", "S5 Test", "example.com"),
    co("906", "Flightpath Golf", "flightpathgolf.com"),
    co("907", "Flightpath Golf", "clickableimpact.com"),
  ], existing);
  assertEquals(p.create.map((c) => c.hubspot_company_id), ["906"]);
  assertEquals(p.link.length, 0);
  assertEquals(p.skipped, { total: 3, already_linked: 0, no_name: 1, test: 2 });
});

Deno.test("isTestRecord: real brands with 'test' inside a word pass", () => {
  assertEquals(isTestRecord({ name: "TEST slide-out co", domain: "test-slideout-example.com" }), true);
  assertEquals(isTestRecord({ name: "Contest Kings", domain: "contestkings.com" }), false);
  assertEquals(isTestRecord({ name: "Testosterone Labs", domain: "trtlabs.com" }), false);
});

Deno.test("planClientSync: punctuation and subdomains do not make a second client", () => {
  const ex: ExistingClient[] = [{ id: "p1", company_name: "Pipeliner's Cloud", website_url: "https://shop.pipelinerscloud.com", hubspot_company_id: "538" }];
  const p = planClientSync([co("900000000000700", "Pipeliners Cloud", "pipelinerscloud.com")], ex);
  assertEquals(p.create.length, 0);
  const q = planClientSync([co("901", "Other Co", "www.brand.co.uk")], [{ id: "b1", company_name: "Brand UK", website_url: "https://shop.brand.co.uk", hubspot_company_id: null }]);
  assertEquals(q.link, [{ clientId: "b1", companyId: "901" }]);
});
