import { assertEquals } from "jsr:@std/assert@1";
import { clientMatch, clientReason, domainWord, emailDomain, myshopifyOf, nameKeys, type HubClient } from "./outreach-clients.ts";

const clients: HubClient[] = [
  { id: "1", name: "Something Borrowed Blooms", status: "Active", domains: ["somethingborrowedblooms.com"] },
  { id: "2", name: "Pipeliners Cloud", status: "Active", domains: ["shop.pipelinerscloud.com", "pipelinerscloud.myshopify.com"] },
  { id: "3", name: "Shiti Coolers", status: "Active", domains: [] },
  { id: "4", name: "Bloom Nutrition", status: "Completed", domains: ["bloomnu.com"] },
  { id: "5", name: "ECD Digital Strategy", status: "Active", domains: ["ecdigitalstrategy.com"] },
];

Deno.test("clientMatch: sbblooms.com is Something Borrowed Blooms, by name even before the redirect is read", () => {
  const m = clientMatch({ domains: ["sbblooms.com"], names: ["SB Blooms"] }, clients);
  assertEquals(m?.client.id, "1");
});

Deno.test("clientMatch: a site that redirects to a client domain", () => {
  const m = clientMatch({ domains: ["xyz-redirect.com", "somethingborrowedblooms.com"] }, clients);
  assertEquals(m?.client.id, "1");
  assertEquals(m?.why, "xyz-redirect.com goes to somethingborrowedblooms.com");
});

Deno.test("clientMatch: parent domain of a client filed under a subdomain, and its myshopify store", () => {
  assertEquals(clientMatch({ domains: ["pipelinerscloud.com"] }, clients)?.client.id, "2");
  assertEquals(clientMatch({ domains: ["other.com", null, "pipelinerscloud.myshopify.com"] }, clients)?.client.id, "2");
});

Deno.test("clientMatch: a client with no website, by name", () => {
  assertEquals(clientMatch({ domains: ["shiticoolers.com"] }, clients)?.client.id, "3");
  assertEquals(clientMatch({ domains: ["coolers-online.com"], names: ["Shiti Coolers Co."] }, clients)?.client.id, "3");
});

Deno.test("clientMatch: guest email at the client's domain; free mail never matches", () => {
  assertEquals(clientMatch({ domains: ["newbrand.com"], emails: ["jo@bloomnu.com"] }, clients)?.client.id, "4");
  assertEquals(clientMatch({ domains: ["newbrand.com"], emails: ["jo@gmail.com"] }, clients), null);
});

Deno.test("clientMatch: unrelated brands pass, including near names and other myshopify stores", () => {
  assertEquals(clientMatch({ domains: ["bloomscape.com"], names: ["Bloomscape"] }, clients), null);
  assertEquals(clientMatch({ domains: ["blooms.com"], names: ["Blooms"] }, clients), null);
  assertEquals(clientMatch({ domains: ["acme.myshopify.com"] }, clients), null);
  assertEquals(clientMatch({ domains: ["acme.com"], emails: ["x@ecdigitalstrategy.com"] }, clients), null);
});

Deno.test("clientReason: past clients say so", () => {
  assertEquals(clientReason({ client: clients[3], why: "bloomnu.com" }), "Already a past ECD client: Bloom Nutrition (bloomnu.com)");
  assertEquals(clientReason({ client: clients[0], why: "x" }), "Already an ECD client: Something Borrowed Blooms (x)");
});

Deno.test("helpers", () => {
  assertEquals(nameKeys("Something Borrowed Blooms"), ["somethingborrowedblooms", "sbblooms"]);
  assertEquals(domainWord("shop.brand-name.co.uk"), "brandname");
  assertEquals(emailDomain("A@Brand.com"), "brand.com");
  assertEquals(myshopifyOf(`<script>Shopify.shop = "acme-store.myshopify.com";</script>`), "acme-store.myshopify.com");
});
