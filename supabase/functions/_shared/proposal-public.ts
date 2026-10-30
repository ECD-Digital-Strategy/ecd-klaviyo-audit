import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export const PUBLIC_TOKEN_RE = /^[0-9a-f]{24}$/;

export const PROPOSAL_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type, accept, origin, referer, user-agent",
  "access-control-allow-methods": "POST, OPTIONS",
};

export function proposalJson(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: {
      ...PROPOSAL_CORS_HEADERS,
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
    ...init,
  });
}

export type LineItemRow = {
  id: string;
  name: string;
  description: string;
  content: string;
  one_time_price: number | string | null;
  one_time_label: string | null;
  monthly_price: number | string | null;
  monthly_label: string | null;
  image_url: string | null;
  display_order: number;
  /** Optional line (2026-10-30): the client chooses whether to add it when signing. */
  optional?: boolean | null;
  /** Optional lines: true = added when signing, false = declined, null = not decided yet. */
  client_selected?: boolean | null;
};

/** Mirror of src/lib/proposal-pricing.ts lineIsTaken: every regular line, and an optional
 * one the client added (or, before the choice is saved, picked). */
export function lineIsTaken(item: Pick<LineItemRow, "id" | "optional" | "client_selected">, picked?: ReadonlySet<string>): boolean {
  if (!item.optional) return true;
  if (item.client_selected != null) return item.client_selected;
  return picked?.has(item.id) ?? false;
}

type DiscountFields = {
  discount_type: "none" | "fixed" | "percent";
  discount_value: number | string;
  discount_applies_to: "one_time" | "monthly" | "both";
};

export type ProposalTotals = {
  oneTimeSubtotal: number;
  monthlySubtotal: number;
  oneTimeDiscount: number;
  monthlyDiscount: number;
  oneTimeTotal: number;
  monthlyTotal: number;
};

function numeric(value: number | string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Mirror of src/lib/proposal-pricing.ts computeProposalTotals; the sign function
 * recomputes totals server-side and freezes them into the signed event metadata. */
export function computeProposalTotals(items: LineItemRow[], discount: DiscountFields, picked?: ReadonlySet<string>): ProposalTotals {
  let oneTimeSubtotal = 0;
  let monthlySubtotal = 0;
  for (const item of items) {
    if (!lineIsTaken(item, picked)) continue;
    const oneTime = numeric(item.one_time_price);
    const monthly = numeric(item.monthly_price);
    if (oneTime) oneTimeSubtotal += oneTime;
    if (monthly) monthlySubtotal += monthly;
  }

  const value = Number(discount.discount_value) || 0;
  const unitDiscount = (subtotal: number, applies: boolean): number => {
    if (!applies || discount.discount_type === "none" || value <= 0 || subtotal <= 0) return 0;
    if (discount.discount_type === "fixed") return Math.min(value, subtotal);
    const pct = Math.min(Math.max(value, 0), 100);
    return (subtotal * pct) / 100;
  };

  const oneTimeDiscount = unitDiscount(
    oneTimeSubtotal,
    discount.discount_applies_to === "one_time" || discount.discount_applies_to === "both",
  );
  const monthlyDiscount = unitDiscount(
    monthlySubtotal,
    discount.discount_applies_to === "monthly" || discount.discount_applies_to === "both",
  );

  return {
    oneTimeSubtotal,
    monthlySubtotal,
    oneTimeDiscount,
    monthlyDiscount,
    oneTimeTotal: Math.max(0, oneTimeSubtotal - oneTimeDiscount),
    monthlyTotal: Math.max(0, monthlySubtotal - monthlyDiscount),
  };
}

/** "Totals: $9,975 one-time." for team emails, leaving out a side that is $0
 * (most proposals have no monthly fee, and "plus $0/mo" read like a mistake). */
export function totalsEmailLine(totals: ProposalTotals): string {
  const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  const parts = [
    totals.oneTimeTotal > 0 ? `${money(totals.oneTimeTotal)} one-time` : null,
    totals.monthlyTotal > 0 ? `${money(totals.monthlyTotal)}/mo` : null,
  ].filter(Boolean);
  return `Totals: ${parts.length ? parts.join(" plus ") : "$0"}.`;
}

/** Deterministic snapshot of exactly what the client saw and agreed to at signing
 * time: content, pricing, and contract text, but not administrative/mutable fields
 * like status or timestamps. Hashed and frozen into the "signed" event so any later
 * edit to the proposal or contract docs is detectable against what was signed. */
export function buildSignedPayloadSnapshot(
  proposal: {
    title: string;
    content_blocks: unknown;
    include_contracts: unknown;
    contracts_snapshot: unknown;
    discount_type: string;
    discount_value: number | string;
    discount_applies_to: string;
    discount_label: string | null;
  },
  lineItems: LineItemRow[],
  totals: ProposalTotals,
) {
  return {
    title: proposal.title,
    content_blocks: proposal.content_blocks ?? [],
    include_contracts: proposal.include_contracts ?? [],
    contracts_snapshot: proposal.contracts_snapshot ?? [],
    discount_type: proposal.discount_type,
    discount_value: Number(proposal.discount_value ?? 0),
    discount_applies_to: proposal.discount_applies_to,
    discount_label: proposal.discount_label ?? null,
    line_items: lineItems.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      content: item.content,
      one_time_price: numeric(item.one_time_price),
      one_time_label: item.one_time_label ?? null,
      monthly_price: numeric(item.monthly_price),
      monthly_label: item.monthly_label ?? null,
      display_order: item.display_order,
      ...(item.optional ? { optional: true, client_selected: item.client_selected === true } : {}),
    })),
    totals,
  };
}

/** SHA-256 hex digest of a JSON-serializable value, used as a tamper-evidence
 * fingerprint for what was signed (JSON.stringify preserves object key insertion
 * order, so the same input always produces the same hash). */
export async function hashSignedPayload(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function isProposalExpired(proposal: { status: string; valid_until: string | null }): boolean {
  if (proposal.status !== "sent" && proposal.status !== "viewed") return false;
  if (!proposal.valid_until) return false;
  const validUntil = new Date(`${proposal.valid_until}T23:59:59`);
  return Number.isFinite(validUntil.getTime()) && validUntil < new Date();
}

/** Fetch a proposal by public token with its public-safe relations. Returns null for
 * unknown tokens AND drafts (indistinguishable to callers; no status oracle).
 * Matches either signer's token; signerIndex says which signer this link belongs to. */
export async function fetchPublicProposal(sb: SupabaseClient, token: string) {
  if (!PUBLIC_TOKEN_RE.test(token)) return null;

  const { data: proposal, error } = await sb
    .from("proposals")
    .select("*, client:clients(company_name, website_url)")
    .or(`public_token.eq.${token},public_token2.eq.${token}`)
    .maybeSingle();
  if (error) throw error;
  if (!proposal || proposal.status === "draft") return null;

  const signerIndex: 1 | 2 = proposal.public_token === token ? 1 : 2;

  const [{ data: lineItems, error: liErr }, { data: signatures, error: sigErr }] = await Promise.all([
    sb
      .from("proposal_line_items")
      .select("id, name, description, content, one_time_price, one_time_label, monthly_price, monthly_label, image_url, display_order, optional, client_selected")
      .eq("proposal_id", proposal.id)
      .order("display_order", { ascending: true }),
    sb
      .from("proposal_signatures")
      .select("role, signer_index, signer_name, signature_image, signed_at")
      .eq("proposal_id", proposal.id),
  ]);
  if (liErr) throw liErr;
  if (sigErr) throw sigErr;

  return { proposal, signerIndex, lineItems: (lineItems ?? []) as LineItemRow[], signatures: signatures ?? [] };
}

/** Number of client signatures required before the proposal counts as fully signed. */
export function requiredClientSigners(proposal: { recipient2_email?: string | null }): number {
  return proposal.recipient2_email ? 2 : 1;
}

/** Public payload: only fields the client-facing page needs (including recipient_email,
 * used to pre-fill the sign form -- whoever holds this link already has that address);
 * never internal notes, created_by, or the event log. */
export async function serializePublicProposal(
  sb: SupabaseClient,
  bundle: NonNullable<Awaited<ReturnType<typeof fetchPublicProposal>>>,
) {
  const { proposal, signerIndex, lineItems, signatures } = bundle;

  const { data: settingsRow } = await sb
    .from("platform_settings")
    .select("proposal_settings")
    .eq("id", "default")
    .maybeSingle();
  const settings = (settingsRow?.proposal_settings ?? {}) as Record<string, unknown>;

  const totals = computeProposalTotals(lineItems, proposal);
  const expired = isProposalExpired(proposal);

  return {
    proposal: {
      proposal_number: proposal.proposal_number,
      title: proposal.title,
      status: proposal.status,
      cover: proposal.cover ?? {},
      content_blocks: proposal.content_blocks ?? [],
      include_contracts: proposal.include_contracts ?? [],
      contracts_snapshot: proposal.contracts_snapshot ?? [],
      discount_type: proposal.discount_type,
      discount_value: Number(proposal.discount_value ?? 0),
      discount_applies_to: proposal.discount_applies_to,
      discount_label: proposal.discount_label,
      recipient_name: proposal.recipient_name,
      recipient_email: proposal.recipient_email,
      recipient2_name: proposal.recipient2_name ?? "",
      recipient2_email: proposal.recipient2_email ?? "",
      valid_until: proposal.valid_until,
      sent_at: proposal.sent_at,
      created_at: proposal.created_at,
      client_signed_at: proposal.client_signed_at,
      countersigned_at: proposal.countersigned_at,
    },
    client: {
      company_name: proposal.client?.company_name ?? "",
      website_url: proposal.client?.website_url ?? null,
    },
    line_items: lineItems,
    signatures,
    signer_index: signerIndex,
    totals,
    expired,
    settings: { cover: (settings.cover as Record<string, unknown>) ?? {} },
  };
}
