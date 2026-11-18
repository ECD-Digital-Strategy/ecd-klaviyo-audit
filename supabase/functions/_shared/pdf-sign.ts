// Uploaded PDFs signed on any page (Emil, 2026-11-18: "signatures on pages 47 and 32", like DocuSign).
// The sender places fields on the PDF's pages in the app; the recipient fills them on the public signing page;
// when they sign, document_sign stamps every field into the real PDF and adds a signing certificate page.
// Field positions are fractions of the page AS SHOWN (pdf.js applies the page's rotation), from its top-left, so
// they do not depend on screen size. toUser() maps them back to the PDF's own coordinates for pdf-lib, rotation
// included. The pure parts are tested in pdf-sign.test.ts.

import { degrees, PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "https://esm.sh/pdf-lib@1.17.1";

export type FieldType = "signature" | "initials" | "date" | "name";
export type FieldRole = "recipient" | "sender";
export type PdfField = { id: string; page: number; x: number; y: number; w: number; h: number; type: FieldType; role: FieldRole };

const TYPES = new Set<FieldType>(["signature", "initials", "date", "name"]);
const ROLES = new Set<FieldRole>(["recipient", "sender"]);
export const MAX_FIELDS = 400;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The fields as stored, cleaned: known types and roles, on a real page, inside it, a sensible size. */
export function cleanFields(raw: unknown, pages: number): PdfField[] {
  if (!Array.isArray(raw)) return [];
  const out: PdfField[] = [];
  for (const f of raw.slice(0, MAX_FIELDS)) {
    const r = f as Record<string, unknown>;
    const page = Math.trunc(Number(r.page));
    const type = String(r.type) as FieldType;
    const role = String(r.role) as FieldRole;
    if (!TYPES.has(type) || !ROLES.has(role) || !(page >= 1 && page <= pages)) continue;
    const w = clamp(Number(r.w) || 0, 0.02, 1);
    const h = clamp(Number(r.h) || 0, 0.01, 1);
    const x = clamp(Number(r.x) || 0, 0, 1 - w);
    const y = clamp(Number(r.y) || 0, 0, 1 - h);
    out.push({ id: String(r.id ?? crypto.randomUUID()).slice(0, 64), page, x, y, w, h, type, role });
  }
  return out;
}

/** What the recipient has to provide: a signature image, an initials image, or neither. */
export function recipientNeeds(fields: PdfField[]): { signature: boolean; initials: boolean; any: boolean } {
  const mine = fields.filter((f) => f.role === "recipient");
  return { signature: mine.some((f) => f.type === "signature"), initials: mine.some((f) => f.type === "initials"), any: mine.length > 0 };
}

/**
 * A point on the page as shown (fractions from the top-left of the rotated view) in the PDF's own coordinates.
 * box is the page's crop box (what pdf.js shows), rotation its /Rotate (0, 90, 180, 270, clockwise).
 */
export function toUser(
  fx: number,
  fy: number,
  box: { x: number; y: number; width: number; height: number },
  rotation: number,
): { x: number; y: number } {
  const W = box.width;
  const H = box.height;
  const rot = ((rotation % 360) + 360) % 360;
  // The shown page is W x H, or H x W when turned a quarter.
  const [vw, vh] = rot === 90 || rot === 270 ? [H, W] : [W, H];
  const rx = fx * vw;
  const ry = fy * vh;
  let x: number;
  let y: number;
  if (rot === 90) [x, y] = [ry, rx];
  else if (rot === 180) [x, y] = [W - rx, ry];
  else if (rot === 270) [x, y] = [W - ry, H - rx];
  else [x, y] = [rx, H - ry];
  return { x: box.x + x, y: box.y + y };
}

/** Points per fraction of the shown page, across and down. */
function shownSize(page: PDFPage): { vw: number; vh: number; rot: number } {
  const box = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  return rot === 90 || rot === 270 ? { vw: box.height, vh: box.width, rot } : { vw: box.width, vh: box.height, rot };
}

/** Text in the standard font: characters it can't draw become "?" rather than failing the whole PDF. */
function drawable(font: PDFFont, text: string): string {
  let out = "";
  for (const ch of text) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

async function embedDataUrl(doc: PDFDocument, dataUrl: string): Promise<PDFImage | null> {
  const m = dataUrl.match(/^data:image\/(png|jpe?g);base64,(.+)$/);
  if (!m) return null;
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return m[1] === "png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
}

export type Signer = {
  role: FieldRole;
  name: string;
  email: string | null;
  signatureImage: string | null;
  initialsImage?: string | null;
  signedAt: string;
  ip?: string | null;
  device?: string | null;
};

export type StampMeta = {
  title: string;
  documentNumber: number | null;
  documentId: string;
  originalSha256: string;
  sentAt: string | null;
  firstViewedAt: string | null;
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
const fmtStamp = (iso: string | null) => (iso ? `${new Date(iso).toISOString().replace("T", " ").slice(0, 19)} UTC` : "-");

const initialsOf = (name: string) =>
  name.split(/\s+/).filter(Boolean).map((p) => p[0]!.toUpperCase()).join("").slice(0, 3) || "?";

/** The signed PDF: every field filled in place, then one certificate page at the end. */
export async function stampPdf(original: Uint8Array, fields: PdfField[], signers: Signer[], meta: StampMeta): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original, { ignoreEncryption: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const images = new Map<string, PDFImage | null>();
  const image = async (key: string, dataUrl: string | null | undefined) => {
    if (!dataUrl) return null;
    if (!images.has(key)) images.set(key, await embedDataUrl(doc, dataUrl));
    return images.get(key) ?? null;
  };

  for (const f of fields) {
    const signer = signers.find((s) => s.role === f.role);
    const page = pages[f.page - 1];
    if (!signer || !page) continue;
    const box = page.getCropBox();
    const { vw, vh, rot } = shownSize(page);
    const bw = f.w * vw;
    const bh = f.h * vh;
    // Everything is drawn upright as the page is shown: anchored at the box's shown bottom-left, turned with the page.
    const at = (dx: number, dy: number) => toUser(f.x + dx / vw, f.y + f.h - dy / vh, box, rot);

    if (f.type === "signature" || f.type === "initials") {
      const img = f.type === "signature" ? await image(`${f.role}:sig`, signer.signatureImage) : await image(`${f.role}:ini`, signer.initialsImage);
      if (img) {
        const scale = Math.min(bw / img.width, bh / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        const o = at((bw - w) / 2, (bh - h) / 2);
        page.drawImage(img, { x: o.x, y: o.y, width: w, height: h, rotate: degrees(rot) });
        continue;
      }
      // No initials drawn (the sender's): their initials as text.
      const text = drawable(italic, f.type === "initials" ? initialsOf(signer.name) : signer.name);
      const size = Math.max(6, Math.min(bh * 0.7, 28, (bw / Math.max(1, italic.widthOfTextAtSize(text, 1))) * 0.95));
      const o = at((bw - italic.widthOfTextAtSize(text, size)) / 2, (bh - size * 0.7) / 2);
      page.drawText(text, { x: o.x, y: o.y, size, font: italic, color: rgb(0.1, 0.1, 0.35), rotate: degrees(rot) });
      continue;
    }
    const text = drawable(font, f.type === "date" ? fmtDate(signer.signedAt) : signer.name);
    const size = Math.max(6, Math.min(bh * 0.65, 14, (bw / Math.max(1, font.widthOfTextAtSize(text, 1))) * 0.98));
    const o = at(2, (bh - size * 0.7) / 2);
    page.drawText(text, { x: o.x, y: o.y, size, font, color: rgb(0.05, 0.05, 0.1), rotate: degrees(rot) });
  }

  // The certificate: who signed, when, from where, and the original file's fingerprint.
  const cert = doc.addPage([612, 792]);
  let y = 740;
  const line = (text: string, opts: { size?: number; f?: PDFFont; gap?: number; color?: [number, number, number] } = {}) => {
    const size = opts.size ?? 10;
    for (const part of wrap(drawable(opts.f ?? font, text), opts.f ?? font, size, 512)) {
      cert.drawText(part, { x: 50, y, size, font: opts.f ?? font, color: rgb(...(opts.color ?? [0.1, 0.1, 0.15])) });
      y -= size + 4;
    }
    y -= opts.gap ?? 0;
  };
  line("Signing certificate", { size: 18, f: bold, gap: 6 });
  line(meta.title || "Untitled document", { size: 12, f: bold });
  line(`${meta.documentNumber ? `DOC-${String(meta.documentNumber).padStart(4, "0")} · ` : ""}Document ID ${meta.documentId}`, { size: 9, color: [0.4, 0.4, 0.45], gap: 10 });
  line("Original file fingerprint (SHA-256)", { size: 9, f: bold });
  line(meta.originalSha256, { size: 9, gap: 4 });
  line(`${pages.length} page${pages.length === 1 ? "" : "s"} · ${fields.length} signing field${fields.length === 1 ? "" : "s"}`, { size: 9, color: [0.4, 0.4, 0.45], gap: 10 });
  line(`Sent: ${fmtStamp(meta.sentAt)}`, { size: 9 });
  line(`First opened by the recipient: ${fmtStamp(meta.firstViewedAt)}`, { size: 9, gap: 12 });
  for (const s of signers) {
    line(s.role === "recipient" ? "Recipient" : "ECD Digital Strategy", { size: 11, f: bold });
    line(`${s.name}${s.email ? ` <${s.email}>` : ""}`, { size: 10 });
    line(`Signed: ${fmtStamp(s.signedAt)}`, { size: 9 });
    if (s.ip) line(`IP address: ${s.ip}`, { size: 9 });
    if (s.device) line(`Device: ${s.device.slice(0, 160)}`, { size: 8, color: [0.4, 0.4, 0.45] });
    y -= 10;
  }
  line("Signed electronically through ECD Digital Strategy's signing tool. Every field above was filled by the signer named for it on the signing page, and the signed copy was produced from the original file with the fingerprint shown.", { size: 8, color: [0.4, 0.4, 0.45] });

  return await doc.save();
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
