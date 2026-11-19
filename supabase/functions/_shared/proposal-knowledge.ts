// Agency Knowledge for the proposal AI (Xiomara, 2026-11-19: "add our new email warmup process as Knowledge, so any
// proposal that includes a warmup reflects the new process automatically"). Short, editable entries in Proposal
// settings (proposal_settings.knowledge), each one a service's current rules plus optional client-facing reference
// wording. Every proposal the AI writes (proposal_agent, proposal_draft_from_audit) gets the enabled entries, with the
// instruction to follow them whenever the proposal includes that service. Short rules beat a pasted document: the AI
// follows them reliably, and the reference wording stays client-safe because the internal version is never stored.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type KnowledgeEntry = {
  id: string;
  title: string;
  /** When it applies, in words: "Any proposal that includes an email or domain warmup". */
  applies_when: string;
  /** The rules the AI must follow (scope, limits, prices, exclusions, obligations). */
  rules: string;
  /** Client-facing wording to borrow from (optional). */
  reference?: string;
  enabled: boolean;
  updated_at?: string;
};

const MAX_RULES = 6000;
const MAX_REFERENCE = 8000;
const MAX_TOTAL = 30000;

export function cleanKnowledge(raw: unknown): KnowledgeEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (r && typeof r === "object" ? r : {}) as Record<string, unknown>)
    .filter((r) => typeof r.title === "string" && r.title.trim() && typeof r.rules === "string" && r.rules.trim())
    .map((r) => ({
      id: String(r.id ?? r.title),
      title: String(r.title).trim(),
      applies_when: String(r.applies_when ?? "").trim(),
      rules: String(r.rules).trim().slice(0, MAX_RULES),
      reference: typeof r.reference === "string" ? r.reference.trim().slice(0, MAX_REFERENCE) : "",
      enabled: r.enabled !== false,
      updated_at: typeof r.updated_at === "string" ? r.updated_at : undefined,
    }));
}

/** The block for the system prompt, or "" when there is no enabled entry. Pure, tested. */
export function knowledgePrompt(entries: KnowledgeEntry[]): string {
  const on = entries.filter((e) => e.enabled);
  if (!on.length) return "";
  const parts: string[] = [];
  let used = 0;
  for (const e of on) {
    const block = [
      `### ${e.title}`,
      e.applies_when ? `Applies when: ${e.applies_when}` : "",
      `Rules:\n${e.rules}`,
      e.reference ? `Client-facing reference wording (borrow from it, adapt it to the proposal; do not paste it whole):\n${e.reference}` : "",
    ].filter(Boolean).join("\n");
    if (used + block.length > MAX_TOTAL) break;
    parts.push(block);
    used += block.length;
  }
  return [
    "AGENCY KNOWLEDGE (ECD's current rules for specific services, kept up to date by the team).",
    "When the proposal includes one of these services, follow its rules exactly: they override the templates, earlier proposals, the client memory and anything you assume about the service. Where they say \"up to\", keep it as a limit, never a promise. Do not add services, guarantees or prices they exclude. If the proposal does not involve a service, ignore its entry.",
    ...parts,
  ].join("\n\n");
}

export async function readKnowledge(sb: SupabaseClient): Promise<string> {
  const { data } = await sb.from("platform_settings").select("proposal_settings").eq("id", "default").maybeSingle();
  const settings = ((data as { proposal_settings?: { knowledge?: unknown } } | null)?.proposal_settings ?? {});
  return knowledgePrompt(cleanKnowledge(settings.knowledge));
}
