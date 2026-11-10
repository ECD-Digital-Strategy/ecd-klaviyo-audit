import { normalizeToArray } from "../_shared/tool-payload.ts";
import { impliesOptional } from "./line-optional.ts";

// Hand-rolled validation + copy sanitizing for agent payloads.

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Remove em/en dashes from generated copy. Digit ranges become hyphens, prose becomes commas. */
export function sanitizeCopy(input: string): string {
  if (!input) return input;
  return input
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")
    .replace(/\s*[–—]\s*/g, ", ")
    .replace(/[–—]/g, ", ");
}

/**
 * Strip internal history annotations the model sometimes echoes into its visible
 * reply (e.g. "[Asked the user: ...]"). Only applied to the chat text, never to
 * proposal payload content (which may legitimately contain [markdown](links)).
 */
export function stripInternalNotes(input: string): string {
  if (!input) return input;
  return input
    .replace(
      /^[ \t]*\[(?:Asked the user|Proposed a draft|Proposed edits|Proposed a set of edits|Source content fetched)[^\]]*\][ \t]*$/gim,
      "",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Recursively sanitize every string in an object. */
export function deepSanitize<T>(value: T): T {
  if (typeof value === "string") return sanitizeCopy(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => deepSanitize(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = deepSanitize(v);
    return out as unknown as T;
  }
  return value;
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}
function isNumOrNull(v: unknown): v is number | null {
  return v === null || v === undefined || typeof v === "number";
}
function isStrOrNull(v: unknown): v is string | null {
  return v === null || v === undefined || typeof v === "string";
}
function isNegative(v: unknown): boolean {
  return typeof v === "number" && v < 0;
}

// ask_user validation is shared with the document assistant.
export { validateQuestion } from "../_shared/ask-user.ts";

function validateLineItem(item: any, label: string): string | null {
  if (!item || typeof item !== "object") return `${label} must be an object`;
  if (!isStr(item.name) || !item.name.trim()) return `${label}.name is required`;
  if (!isStr(item.description)) return `${label}.description must be a string`;
  if (!isStr(item.content)) return `${label}.content must be a string`;
  if (!isNumOrNull(item.one_time_price)) return `${label}.one_time_price must be a number or null`;
  if (!isNumOrNull(item.monthly_price)) return `${label}.monthly_price must be a number or null`;
  if (!isStrOrNull(item.one_time_label)) return `${label}.one_time_label must be a string or null`;
  if (!isStrOrNull(item.monthly_label)) return `${label}.monthly_label must be a string or null`;
  if (isNegative(item.one_time_price) || isNegative(item.monthly_price)) {
    return `${label}: prices cannot be negative; use a discount to lower the total`;
  }
  if (item.optional != null && typeof item.optional !== "boolean") return `${label}.optional must be true or false`;
  if (item.one_time_price == null && item.monthly_price == null) {
    return `${label} needs at least one of one_time_price or monthly_price`;
  }
  // A line named "Optional ..." is always optional (never flipped back to false).
  if (impliesOptional(item.name)) item.optional = true;
  return null;
}

const DISCOUNT_TYPES = new Set(["none", "fixed", "percent"]);
const DISCOUNT_APPLIES = new Set(["one_time", "monthly", "both"]);

function validateDiscount(d: any): string | null {
  if (d == null) return null;
  if (typeof d !== "object") return "discount must be an object";
  if (!DISCOUNT_TYPES.has(d.type)) return "discount.type must be none|fixed|percent";
  if (typeof d.value !== "number" || d.value < 0) return "discount.value must be a non-negative number";
  if (!DISCOUNT_APPLIES.has(d.applies_to)) return "discount.applies_to must be one_time|monthly|both";
  if (!isStrOrNull(d.label)) return "discount.label must be a string or null";
  return null;
}

export function validateDraft(input: any): ValidationResult<any> {
  if (!input || typeof input !== "object") return { ok: false, error: "propose_draft input must be an object" };
  if (!isStr(input.title) || !input.title.trim()) return { ok: false, error: "title is required" };
  if (!isStr(input.summary) || !input.summary.trim()) return { ok: false, error: "summary is required" };
  if (!Array.isArray(input.content_blocks) || input.content_blocks.length === 0) {
    return { ok: false, error: "content_blocks must be a non-empty array" };
  }
  for (let i = 0; i < input.content_blocks.length; i++) {
    const b = input.content_blocks[i];
    if (!b || !isStr(b.title) || !b.title.trim() || !isStr(b.content)) {
      return { ok: false, error: `content_blocks[${i}] needs a title and markdown content` };
    }
  }
  if (!Array.isArray(input.line_items) || input.line_items.length === 0) {
    return { ok: false, error: "line_items must be a non-empty array" };
  }
  for (let i = 0; i < input.line_items.length; i++) {
    const err = validateLineItem(input.line_items[i], `line_items[${i}]`);
    if (err) return { ok: false, error: err };
  }
  const dErr = validateDiscount(input.discount);
  if (dErr) return { ok: false, error: dErr };
  if (input.include_contracts != null) {
    if (!Array.isArray(input.include_contracts) || input.include_contracts.some((s: unknown) => !isStr(s))) {
      return { ok: false, error: "include_contracts must be an array of slugs" };
    }
  }
  if (!isStrOrNull(input.client_id) || !isStrOrNull(input.recipient_name) || !isStrOrNull(input.recipient_email)) {
    return { ok: false, error: "client_id, recipient_name, recipient_email must be strings or null" };
  }
  return { ok: true, value: input };
}

const EDIT_OPS = new Set([
  "update_title",
  "update_block",
  "add_block",
  "remove_block",
  "add_line_item",
  "update_line_item",
  "delete_line_item",
  "update_discount",
  "toggle_contract",
  "override_contract",
  "update_recipient",
  "set_agency_signer",
]);

/** True when propose_edits carried no operations at all. The caller treats this
 * as "the assistant decided nothing should change", which is a legitimate answer
 * to a message like "no, don't add it", rather than a malformed payload. */
export function isEmptyEditSet(input: unknown): boolean {
  const rec = input as { operations?: unknown } | null;
  if (!rec || typeof rec !== "object") return false;
  const ops = normalizeToArray(rec.operations);
  return Array.isArray(ops) && ops.length === 0;
}

export function validateEditSet(
  input: any,
  ctx: {
    blockKeys: Set<string>;
    itemIds: Set<string>;
    contractSlugs: Set<string>;
    /** Blocks sent cut short (truncated: true in the snapshot): their content must not be replaced. */
    truncatedBlockKeys?: Set<string>;
  },
): ValidationResult<any> {
  if (!input || typeof input !== "object") return { ok: false, error: "propose_edits input must be an object" };
  if (!isStr(input.summary) || !input.summary.trim()) return { ok: false, error: "summary is required" };
  const normalized = normalizeToArray(input.operations);
  if (normalized === null) {
    return {
      ok: false,
      error:
        "operations could not be read as a list of edits. Send it as a JSON array of operation objects, not as text.",
    };
  }
  input.operations = normalized;
  if (input.operations.length === 0) {
    return {
      ok: false,
      error:
        "operations was empty. If the proposal should change, include at least one operation. If nothing should change, do NOT call propose_edits: reply with a short message instead.",
    };
  }
  for (let i = 0; i < input.operations.length; i++) {
    const o = input.operations[i];
    const label = `operations[${i}]`;
    if (!o || typeof o !== "object" || !EDIT_OPS.has(o.op)) {
      return { ok: false, error: `${label}.op must be one of: ${[...EDIT_OPS].join(", ")}` };
    }
    switch (o.op) {
      case "update_title":
        if (!isStr(o.title) || !o.title.trim()) return { ok: false, error: `${label}: title is required` };
        break;
      case "update_block":
        if (!isStr(o.block_key) || !ctx.blockKeys.has(o.block_key)) {
          return { ok: false, error: `${label}: block_key must match an existing block key` };
        }
        if (o.title == null && o.content == null) {
          return { ok: false, error: `${label}: provide title and/or content` };
        }
        if (o.content != null && ctx.truncatedBlockKeys?.has(o.block_key)) {
          return {
            ok: false,
            error: `${label}: block ${o.block_key} is truncated (too long to send in full), so its content cannot be replaced. Change only its title, or tell the user to edit that section by hand.`,
          };
        }
        break;
      case "add_block":
        if (!isStr(o.title) || !o.title.trim() || !isStr(o.content)) {
          return { ok: false, error: `${label}: title and content are required` };
        }
        if (o.after_key != null && !ctx.blockKeys.has(o.after_key)) {
          return { ok: false, error: `${label}: after_key must match an existing block key or be null` };
        }
        break;
      case "remove_block":
        if (!isStr(o.block_key) || !ctx.blockKeys.has(o.block_key)) {
          return { ok: false, error: `${label}: block_key must match an existing block key` };
        }
        break;
      case "add_line_item": {
        const err = validateLineItem(o.item, `${label}.item`);
        if (err) return { ok: false, error: err };
        break;
      }
      case "update_line_item":
        if (!isStr(o.item_id) || !ctx.itemIds.has(o.item_id)) {
          return { ok: false, error: `${label}: item_id must match an existing line item id` };
        }
        if (!o.patch || typeof o.patch !== "object" || Object.keys(o.patch).length === 0) {
          return { ok: false, error: `${label}: patch must contain at least one field` };
        }
        if (!isNumOrNull(o.patch.one_time_price) || !isNumOrNull(o.patch.monthly_price)) {
          return { ok: false, error: `${label}: prices must be numbers or null` };
        }
        if (isNegative(o.patch.one_time_price) || isNegative(o.patch.monthly_price)) {
          return { ok: false, error: `${label}: prices cannot be negative; use a discount to lower the total` };
        }
        if (o.patch.optional != null && typeof o.patch.optional !== "boolean") {
          return { ok: false, error: `${label}: optional must be true or false` };
        }
        // Renamed to "Optional ...": the line becomes optional.
        if (isStr(o.patch.name) && impliesOptional(o.patch.name)) o.patch.optional = true;
        break;
      case "delete_line_item":
        if (!isStr(o.item_id) || !ctx.itemIds.has(o.item_id)) {
          return { ok: false, error: `${label}: item_id must match an existing line item id` };
        }
        break;
      case "update_discount": {
        const err = validateDiscount(o.discount);
        if (err) return { ok: false, error: `${label}: ${err}` };
        if (o.discount == null) return { ok: false, error: `${label}: discount is required` };
        break;
      }
      case "toggle_contract":
        if (!isStr(o.slug) || !ctx.contractSlugs.has(o.slug)) {
          return { ok: false, error: `${label}: slug must be a known contract slug` };
        }
        if (typeof o.included !== "boolean") return { ok: false, error: `${label}: included must be boolean` };
        break;
      case "override_contract": {
        if (!isStr(o.slug) || !ctx.contractSlugs.has(o.slug)) {
          return { ok: false, error: `${label}: slug must be a known contract slug` };
        }
        // Redlines (preferred): a list of verbatim find/replace pairs, applied
        // server-side. Otherwise null clears the override, or a full document
        // replaces it.
        if (Array.isArray(o.contract_edits)) {
          if (o.contract_edits.length === 0) return { ok: false, error: `${label}: contract_edits is empty` };
          for (let j = 0; j < o.contract_edits.length; j++) {
            const e = o.contract_edits[j];
            if (!e || typeof e !== "object" || !isStr(e.find) || !isStr(e.replace)) {
              return { ok: false, error: `${label}.contract_edits[${j}] must be { find: string, replace: string }` };
            }
          }
          break;
        }
        if (o.contract_content === undefined) {
          return { ok: false, error: `${label}: provide contract_edits (preferred), or contract_content, or contract_content: null to reset` };
        }
        if (o.contract_content !== null && !isStr(o.contract_content)) {
          return { ok: false, error: `${label}: contract_content must be the full contract text, or null to reset` };
        }
        if (isStr(o.contract_content) && o.contract_content.trim().length < 40) {
          return {
            ok: false,
            error: `${label}: contract_content looks like a fragment. Use contract_edits with the exact passage to change instead.`,
          };
        }
        break;
      }
      case "update_recipient":
        if (o.recipient_name == null && o.recipient_email == null) {
          return { ok: false, error: `${label}: provide recipient_name and/or recipient_email` };
        }
        break;
      // The name stays free text: the app matches it against the real team list
      // and keeps the current signer when nothing matches, so a typo can never
      // sign as the wrong person.
      case "set_agency_signer":
        if (!isStr(o.signer) || !o.signer.trim()) {
          return { ok: false, error: `${label}: provide signer (a team member's name or email)` };
        }
        break;
    }
  }
  return { ok: true, value: input };
}
