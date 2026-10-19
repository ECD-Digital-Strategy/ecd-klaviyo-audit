import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { xeroApi } from "./xero.ts";
import { familyKey } from "./xero-accounts.ts";
import { type MatchCandidate, matchLine } from "./xero-match.ts";
import { createLlmClient, type LlmTool } from "./llm-adapter.ts";

// Code freehand proposal lines for Xero: their revenue family and the Xero
// Item for each price. Most proposals are written by hand or by the assistant,
// so their lines link to no catalog service (iHome Health Fitness, Oct 19,
// 2026). First a clear name match against the catalog and Xero's Items; then,
// for what is left, Claude reads the line and picks from the real list. Its
// answers are checked against that list and only confident ones are used.
// Whatever is set is saved on the line, so it shows and can be changed.

export type CodableLine = {
  id: string;
  name: string;
  description: string | null;
  one_time_price: number | string | null;
  monthly_price: number | string | null;
  xero_service_key: string | null;
  xero_item_one_time: string | null;
  xero_item_monthly: string | null;
};

type Kind = "one_time" | "monthly";
type XeroItemRow = { code: string; name: string; account: string | null };

const FAMILIES: Record<string, string> = {
  retention: "Retention: email, SMS, Klaviyo builds and management, direct mail (PostPilot), reviews, Alia and AI agents the Klaviyo team sets up",
  website: "Website: Shopify, site design and development, CRO, website management, subscription apps, Amazon",
  paid_ads: "Paid ads: Meta, Google, Bing and Pinterest ads setup and management",
};

const price = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const kindsOf = (l: CodableLine): Kind[] =>
  (["one_time", "monthly"] as const).filter((k) => price(k === "one_time" ? l.one_time_price : l.monthly_price) > 0);
const itemField = (k: Kind): "xero_item_one_time" | "xero_item_monthly" => (k === "one_time" ? "xero_item_one_time" : "xero_item_monthly");
const needsCoding = (l: CodableLine) =>
  kindsOf(l).length > 0 && (!familyKey(l.xero_service_key) || kindsOf(l).some((k) => !l[itemField(k)]));

/** Xero's sold Items, and the catalog services, as name-match candidates per
 * kind (an ongoing Item sits on 400x, a one-time one on 401x). */
async function candidates(sb: SupabaseClient): Promise<{ byKind: Record<Kind, MatchCandidate[]>; items: XeroItemRow[] }> {
  const byKind: Record<Kind, MatchCandidate[]> = { one_time: [], monthly: [] };
  const { data: services } = await sb
    .from("revenue_opportunity_templates")
    .select("name, xero_service_key, xero_item_one_time, xero_item_monthly")
    .eq("is_active", true);
  for (const s of services ?? []) {
    const family = familyKey((s.xero_service_key as string | null) ?? null);
    if (!family) continue;
    if (s.xero_item_one_time) byKind.one_time.push({ name: s.name as string, itemCode: s.xero_item_one_time as string, family, account: null });
    if (s.xero_item_monthly) byKind.monthly.push({ name: s.name as string, itemCode: s.xero_item_monthly as string, family, account: null });
  }
  // deno-lint-ignore no-explicit-any
  const out = await xeroApi<{ Items?: Array<Record<string, any>> }>(sb, "/Items").catch(() => null);
  const items: XeroItemRow[] = [];
  for (const i of out?.Items ?? []) {
    if (!i.IsSold || !i.Code) continue;
    const row = { code: String(i.Code), name: String(i.Name ?? i.Code), account: (i.SalesDetails?.AccountCode as string | undefined) ?? null };
    items.push(row);
    const candidate = { name: row.name, itemCode: row.code, family: null, account: row.account };
    if (row.account && /^400/.test(row.account)) byKind.monthly.push(candidate);
    else if (row.account && /^401/.test(row.account)) byKind.one_time.push(candidate);
  }
  return { byKind, items };
}

const CODE_TOOL: LlmTool = {
  name: "record_xero_coding",
  description: "Record the Xero revenue family and Items for each proposal line.",
  input_schema: {
    type: "object",
    required: ["lines"],
    properties: {
      lines: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "family", "confident"],
          properties: {
            id: { type: "string" },
            family: { type: "string", enum: Object.keys(FAMILIES) },
            item_one_time: { type: ["string", "null"], description: "Xero Item code for the one-time price, from the list, or null." },
            item_monthly: { type: ["string", "null"], description: "Xero Item code for the monthly price, from the list, or null." },
            confident: { type: "boolean", description: "False when the line could fit more than one family or Item." },
          },
        },
      },
    },
  },
};

async function askClaude(
  lines: CodableLine[],
  items: XeroItemRow[],
  title: string,
): Promise<Map<string, { family: string; one: string | null; monthly: string | null }>> {
  const out = new Map<string, { family: string; one: string | null; monthly: string | null }>();
  if (!lines.length) return out;
  const llm = createLlmClient("anthropic", { model: "claude-sonnet-5-5" });
  const turn = await llm.runTurn({
    system:
      "You code an agency's proposal lines for its Xero accounting. Pick each line's revenue family and the Xero Item that best describes it.\n" +
      `Families:\n${Object.entries(FAMILIES).map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n` +
      "A one-time price takes an Item for one-time work, a monthly price an Item for ongoing work. Use only codes from the list. " +
      "If no Item fits, use null for it. Set confident to false whenever a line could reasonably fit another family or Item.",
    messages: [{
      role: "user",
      text: `Proposal: ${title}\n\nXero Items (code | name | its account):\n${items.map((i) => `${i.code} | ${i.name} | ${i.account ?? "-"}`).join("\n")}\n\n` +
        `Lines:\n${lines.map((l) => `id ${l.id}: "${l.name}"${l.description ? `, ${l.description.slice(0, 300)}` : ""}. Prices: ${kindsOf(l).join(" and ")}.`).join("\n")}`,
    }],
    tools: [CODE_TOOL],
    toolChoice: { type: "tool", name: CODE_TOOL.name },
  });
  if (turn.kind !== "tool_call") return out;
  const known = new Set(items.map((i) => i.code));
  const rows = (turn.input as { lines?: Array<Record<string, unknown>> })?.lines ?? [];
  for (const r of rows) {
    const family = String(r.family ?? "");
    if (!r.confident || !FAMILIES[family]) continue;
    const pick = (v: unknown) => (typeof v === "string" && known.has(v) ? v : null);
    out.set(String(r.id), { family, one: pick(r.item_one_time), monthly: pick(r.item_monthly) });
  }
  return out;
}

/** Code what can be coded, save it, and say what was done. Mutates `lines`. */
export async function autoCodeLines(
  sb: SupabaseClient,
  lines: CodableLine[],
  /** dryRun: work it out and report, save nothing (for checking the picks). */
  opts: { title: string; ai: boolean; dryRun?: boolean },
): Promise<{ notes: string[]; coded: number; remaining: number }> {
  const todo = lines.filter(needsCoding);
  if (!todo.length) return { notes: [], coded: 0, remaining: 0 };
  const { byKind, items } = await candidates(sb);
  const patches = new Map<string, Record<string, string>>();
  const how = new Map<string, string>();

  for (const l of todo) {
    const patch: Record<string, string> = {};
    for (const k of kindsOf(l)) {
      const m = matchLine(l.name ?? "", byKind[k]);
      if (!m) continue;
      if (!familyKey(l.xero_service_key) && !patch.xero_service_key) patch.xero_service_key = m.family;
      if (!l[itemField(k)] && m.itemCode) patch[itemField(k)] = m.itemCode;
    }
    if (Object.keys(patch).length) {
      patches.set(l.id, patch);
      how.set(l.id, "name");
    }
  }

  const left = todo.filter((l) => needsCoding({ ...l, ...(patches.get(l.id) ?? {}) }));
  if (opts.ai && left.length) {
    const picks = await askClaude(left, items, opts.title).catch((e) => {
      console.warn("xero autocode: Claude failed", e instanceof Error ? e.message : e);
      return new Map();
    });
    for (const l of left) {
      const p = picks.get(l.id);
      if (!p) continue;
      const patch = { ...(patches.get(l.id) ?? {}) };
      if (!familyKey(l.xero_service_key) && !patch.xero_service_key) patch.xero_service_key = p.family;
      if (price(l.one_time_price) > 0 && !l.xero_item_one_time && !patch.xero_item_one_time && p.one) patch.xero_item_one_time = p.one;
      if (price(l.monthly_price) > 0 && !l.xero_item_monthly && !patch.xero_item_monthly && p.monthly) patch.xero_item_monthly = p.monthly;
      if (Object.keys(patch).length) {
        patches.set(l.id, patch);
        how.set(l.id, how.get(l.id) ? "name and AI" : "AI");
      }
    }
  }

  const notes: string[] = [];
  for (const l of todo) {
    const patch = patches.get(l.id);
    if (!patch) continue;
    if (!opts.dryRun) {
      const { error } = await sb.from("proposal_line_items").update(patch).eq("id", l.id);
      if (error) {
        console.error("xero autocode: could not save", l.id, error.message);
        notes.push(`${l.name}: could not save the pick (${error.message})`);
        continue;
      }
    }
    Object.assign(l, patch);
    const codes = [patch.xero_item_one_time, patch.xero_item_monthly].filter(Boolean).map((c) => `Item ${c}`);
    notes.push(`${l.name} (${how.get(l.id)}): ${[...codes, patch.xero_service_key].filter(Boolean).join(", ")}`);
  }
  return { notes, coded: notes.length, remaining: lines.filter(needsCoding).length };
}
