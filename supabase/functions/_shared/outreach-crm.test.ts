import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { crmSkipReason } from "./outreach-crm.ts";

Deno.test("crmSkipReason: unknown store passes", () => {
  assertEquals(crmSkipReason([]), null);
  assertEquals(crmSkipReason(undefined), null);
});

Deno.test("crmSkipReason: strongest reason wins", () => {
  assertEquals(
    crmSkipReason([
      { kind: "contact", id: "1", label: null },
      { kind: "deal", id: "2", label: "Closed Lost" },
      { kind: "event", id: "3", label: "Retail Club" },
    ]),
    "In the CRM (deal, Closed Lost)",
  );
  assertEquals(crmSkipReason([{ kind: "client", id: "x", label: null }, { kind: "company", id: "4", label: "Brand" }]), "Already an ECD client (CRM)");
});

Deno.test("crmSkipReason: an event guest reads as an event guest, not a company", () => {
  assertEquals(
    crmSkipReason([
      { kind: "company", id: "1", label: "Brand" },
      { kind: "contact", id: "2", label: "event" },
      { kind: "event", id: "e", label: "Sunset & Scale" },
    ]),
    "Came to an ECD event (Sunset & Scale)",
  );
});

Deno.test("crmSkipReason: event and do-not-contact wording", () => {
  assertEquals(crmSkipReason([{ kind: "event", id: "e", label: "League of Originals" }]), "Came to an ECD event (League of Originals)");
  assertEquals(crmSkipReason([{ kind: "suppressed", id: "s", label: "vendor_or_partner" }]), "On the CRM's do-not-contact list (vendor or partner)");
});

Deno.test("crmSkipReason: records Outreach made itself do not block", () => {
  const matches = [
    { kind: "company", id: "900000000000714", label: "Probe" },
    { kind: "contact", id: "900000000000715", label: "Cold outreach" },
  ];
  assertEquals(crmSkipReason(matches, { contactId: "900000000000715", companyId: "900000000000714" }), null);
  assertEquals(crmSkipReason(matches, { contactId: "900000000000715" }), "In the CRM (company)");
});
