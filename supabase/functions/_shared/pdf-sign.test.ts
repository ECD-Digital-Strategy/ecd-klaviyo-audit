import { assert, assertAlmostEquals, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { degrees, PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";
import { cleanFields, recipientNeeds, stampPdf, toUser } from "./pdf-sign.ts";

const box = { x: 0, y: 0, width: 600, height: 800 };
const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  assertAlmostEquals(a.x, b.x, 1e-6);
  assertAlmostEquals(a.y, b.y, 1e-6);
};

Deno.test("toUser: an upright page, top-left origin flipped to PDF's bottom-left", () => {
  near(toUser(0, 0, box, 0), { x: 0, y: 800 });
  near(toUser(1, 1, box, 0), { x: 600, y: 0 });
  near(toUser(0.5, 0.25, box, 0), { x: 300, y: 600 });
});

Deno.test("toUser: rotated pages land on the same physical corner as shown", () => {
  // Shown top-left is the PDF's bottom-left when turned 90 clockwise, its top-right when turned 180, its bottom-right at 270.
  near(toUser(0, 0, box, 90), { x: 0, y: 0 });
  near(toUser(0, 0, box, 180), { x: 600, y: 0 });
  near(toUser(0, 0, box, 270), { x: 600, y: 800 });
  // Shown bottom-right is the opposite corner every time.
  near(toUser(1, 1, box, 90), { x: 600, y: 800 });
  near(toUser(1, 1, box, 180), { x: 0, y: 800 });
  near(toUser(1, 1, box, 270), { x: 0, y: 0 });
});

Deno.test("toUser: a crop box offset is respected", () => {
  near(toUser(0, 0, { x: 20, y: 30, width: 100, height: 200 }, 0), { x: 20, y: 230 });
});

Deno.test("cleanFields keeps good fields inside the page and drops the rest", () => {
  const out = cleanFields([
    { id: "a", page: 2, x: 0.9, y: 0.95, w: 0.3, h: 0.1, type: "signature", role: "recipient" },
    { id: "b", page: 9, x: 0, y: 0, w: 0.1, h: 0.1, type: "signature", role: "recipient" },
    { id: "c", page: 1, x: 0, y: 0, w: 0.1, h: 0.1, type: "stamp", role: "recipient" },
    { id: "d", page: 1, x: 0, y: 0, w: 0.1, h: 0.1, type: "date", role: "boss" },
  ], 3);
  assertEquals(out.map((f) => f.id), ["a"]);
  assertAlmostEquals(out[0].x, 0.7, 1e-9);
  assertAlmostEquals(out[0].y, 0.9, 1e-9);
  assertEquals(cleanFields("nope", 3), []);
});

Deno.test("recipientNeeds", () => {
  const f = cleanFields([
    { page: 1, x: 0, y: 0, w: 0.2, h: 0.05, type: "initials", role: "recipient" },
    { page: 1, x: 0, y: 0, w: 0.2, h: 0.05, type: "signature", role: "sender" },
  ], 1);
  assertEquals(recipientNeeds(f), { signature: false, initials: true, any: true });
});

// A 1x1 transparent PNG.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

Deno.test("stampPdf fills fields on normal and rotated pages and adds the certificate page", async () => {
  const src = await PDFDocument.create();
  src.addPage([612, 792]);
  src.addPage([612, 792]).setRotation(degrees(90));
  const bytes = await src.save();
  const fields = cleanFields([
    { page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.06, type: "signature", role: "recipient" },
    { page: 1, x: 0.5, y: 0.8, w: 0.2, h: 0.04, type: "date", role: "recipient" },
    { page: 2, x: 0.7, y: 0.9, w: 0.1, h: 0.05, type: "initials", role: "recipient" },
    { page: 2, x: 0.1, y: 0.1, w: 0.3, h: 0.06, type: "signature", role: "sender" },
    { page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.04, type: "name", role: "sender" },
  ], 2);
  const out = await stampPdf(bytes, fields, [
    { role: "recipient", name: "Jenny Dickson", email: "jenny@example.com", signatureImage: PNG, initialsImage: PNG, signedAt: "2026-11-18T15:00:00Z", ip: "1.2.3.4", device: "Test" },
    { role: "sender", name: "Zak Cassady-Dorion", email: null, signatureImage: PNG, signedAt: "2026-11-18T10:00:00Z" },
  ], { title: "Test – contract", documentNumber: 7, documentId: "x", originalSha256: "abc", sentAt: null, firstViewedAt: null });
  const signed = await PDFDocument.load(out);
  assertEquals(signed.getPageCount(), 3);
  assert(out.length > bytes.length);
});
