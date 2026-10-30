import { supabase } from './supabase';
import { attachActorNames } from './actor-names';
import { publicProposalOrigin } from './public-origin';
import { resolveSignatureImage } from './signature-image';
import { listStaffSigners, resolveSigner } from './staff-signers';
import {
  MSA_ON_FILE_SLUG,
  MSA_SLUG,
  SIGN_ONCE_SLUGS,
  swapMsaForOnFile,
  withoutSignedAgreements,
  type ExecutedMsa,
} from './msa-on-file';
import type {
  ContractDocument,
  Proposal,
  ProposalEvent,
  ProposalEventType,
  ProposalLineItem,
  ProposalSettings,
  ProposalSignature,
  ProposalTemplate,
} from './types';

export const DEFAULT_PROPOSAL_SETTINGS: ProposalSettings = {
  cover: {
    background_url: null,
    logo_url: null,
    tagline: 'ROI-Driven E-Commerce Marketing Agency',
  },
  email: {
    from_name: 'ECD Digital Strategy',
    from_email: null,
    reply_to: null,
    team_notification_emails: [],
  },
  defaults: {
    valid_days: 30,
  },
  voice_profile: '',
};

export function mergeProposalSettings(raw: unknown): ProposalSettings {
  const value = (raw ?? {}) as Partial<ProposalSettings>;
  return {
    cover: { ...DEFAULT_PROPOSAL_SETTINGS.cover, ...(value.cover ?? {}) },
    email: { ...DEFAULT_PROPOSAL_SETTINGS.email, ...(value.email ?? {}) },
    defaults: { ...DEFAULT_PROPOSAL_SETTINGS.defaults, ...(value.defaults ?? {}) },
    voice_profile: typeof value.voice_profile === 'string' ? value.voice_profile : '',
  };
}

/** Ask the AI to draft a house voice/style profile from recent work. */
export async function generateVoiceProfile(domain: 'proposal' | 'document'): Promise<string> {
  const { data, error } = await supabase.functions.invoke('agent_voice_profile', { body: { domain } });
  if (error) {
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.json();
        throw new Error(body?.error?.message ?? error.message);
      } catch (e) {
        if (e instanceof Error && e.message !== error.message) throw e;
      }
    }
    throw error;
  }
  if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Could not generate a voice profile');
  return String(data.voice_profile ?? '');
}

export async function getProposalSettings(): Promise<ProposalSettings> {
  const { data, error } = await supabase
    .from('platform_settings')
    .select('proposal_settings')
    .eq('id', 'default')
    .maybeSingle();
  if (error || !data) return DEFAULT_PROPOSAL_SETTINGS;
  return mergeProposalSettings(data.proposal_settings);
}

export async function updateProposalSettings(settings: ProposalSettings): Promise<void> {
  const { error } = await supabase
    .from('platform_settings')
    .update({ proposal_settings: settings, updated_at: new Date().toISOString() })
    .eq('id', 'default');
  if (error) throw error;
}

const PROPOSAL_LIST_SELECT = '*, client:clients(*), line_items:proposal_line_items(*)';

function mapProposalRow(row: Record<string, unknown>): Proposal {
  return {
    ...(row as unknown as Proposal),
    cover: (row.cover as Proposal['cover']) ?? {},
    content_blocks: Array.isArray(row.content_blocks) ? (row.content_blocks as Proposal['content_blocks']) : [],
    include_contracts: Array.isArray(row.include_contracts) ? (row.include_contracts as string[]) : [],
    contracts_snapshot: Array.isArray(row.contracts_snapshot)
      ? (row.contracts_snapshot as Proposal['contracts_snapshot'])
      : null,
    contract_overrides:
      row.contract_overrides && typeof row.contract_overrides === 'object' && !Array.isArray(row.contract_overrides)
        ? (row.contract_overrides as Record<string, string>)
        : {},
    discount_value: Number(row.discount_value ?? 0),
    line_items: Array.isArray(row.line_items)
      ? (row.line_items as Record<string, unknown>[])
          .map(mapLineItemRow)
          .sort((a, b) => a.display_order - b.display_order)
      : undefined,
  };
}

function mapLineItemRow(row: Record<string, unknown>): ProposalLineItem {
  return {
    ...(row as unknown as ProposalLineItem),
    one_time_price: row.one_time_price != null ? Number(row.one_time_price) : null,
    monthly_price: row.monthly_price != null ? Number(row.monthly_price) : null,
  };
}

// ---------------------------------------------------------------------------
// Proposals

export async function listProposals(): Promise<Proposal[]> {
  const { data, error } = await supabase
    .from('proposals')
    .select(PROPOSAL_LIST_SELECT)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapProposalRow);
}

export async function listProposalsByClient(clientId: string): Promise<Proposal[]> {
  const { data, error } = await supabase
    .from('proposals')
    .select(PROPOSAL_LIST_SELECT)
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapProposalRow);
}

export async function getProposal(id: string): Promise<Proposal | null> {
  const { data, error } = await supabase
    .from('proposals')
    .select(PROPOSAL_LIST_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? mapProposalRow(data) : null;
}

/** Contracts checked by default on every new proposal (Master Services Agreement
 * + Operating Agreement). Used when a proposal is created without an explicit
 * contract selection. */
export const DEFAULT_INCLUDED_CONTRACTS = ['msa', 'operating_agreement'];

/** The first MSA this client signed, if any. Later proposals point to it
 * rather than attaching the template again (see msa-on-file.ts). */
export async function findExecutedMsa(clientId: string, excludeProposalId?: string): Promise<ExecutedMsa | null> {
  let query = supabase
    .from('proposals')
    .select('id, title, client_signed_at')
    .eq('client_id', clientId)
    .not('client_signed_at', 'is', null)
    // include_contracts is jsonb: an array here is sent as the Postgres literal
    // {msa}, which jsonb rejects with a 400 (broke creating every proposal).
    .contains('include_contracts', JSON.stringify([MSA_SLUG]))
    .order('client_signed_at', { ascending: true })
    .limit(1);
  if (excludeProposalId) query = query.neq('id', excludeProposalId);
  const { data, error } = await query;
  if (error) throw error;
  const row = data?.[0];
  return row ? { proposalId: row.id, proposalTitle: row.title ?? '', signedAt: row.client_signed_at } : null;
}

/** Every agreement this client has signed on an earlier proposal (the
 * on-file reference counts as the MSA). */
export async function findSignedAgreements(clientId: string, excludeProposalId?: string): Promise<Set<string>> {
  let query = supabase
    .from('proposals')
    .select('include_contracts')
    .eq('client_id', clientId)
    .not('client_signed_at', 'is', null);
  if (excludeProposalId) query = query.neq('id', excludeProposalId);
  const { data, error } = await query;
  if (error) throw error;
  const signed = new Set<string>();
  for (const row of data ?? []) {
    for (const slug of Array.isArray(row.include_contracts) ? (row.include_contracts as string[]) : []) {
      signed.add(slug === MSA_ON_FILE_SLUG ? MSA_SLUG : slug);
    }
  }
  return signed;
}

/**
 * Apply the sign-once rules to a contract selection for this client: an MSA
 * they already signed becomes the short on-file reference, and with
 * `dropSigned` (a new proposal or a drafted one) the Operating Agreement and
 * the Termination & Transition Agreement they already signed are left out, so
 * the proposal is the Statement of Work only (Zak, 2026-10-26). A contract a
 * person ticks back on in the editor stays: that call leaves dropSigned off.
 */
export async function resolveContractsForClient(
  clientId: string,
  contracts: string[],
  excludeProposalId?: string,
  opts: { dropSigned?: boolean } = {},
): Promise<{ include_contracts: string[]; overrides: Record<string, string> }> {
  const touchesMsa = contracts.includes(MSA_SLUG) || contracts.includes(MSA_ON_FILE_SLUG);
  const touchesOthers = contracts.some(s => (SIGN_ONCE_SLUGS as readonly string[]).includes(s));
  if (!touchesMsa && !(opts.dropSigned && touchesOthers)) return { include_contracts: contracts, overrides: {} };
  const [msa, signed, { data: client }] = await Promise.all([
    findExecutedMsa(clientId, excludeProposalId),
    findSignedAgreements(clientId, excludeProposalId),
    supabase.from('clients').select('company_name, name').eq('id', clientId).maybeSingle(),
  ]);
  const kept = opts.dropSigned ? withoutSignedAgreements(contracts, signed) : contracts;
  // The reference names the other agreements that still apply without being attached.
  const alsoSigned = SIGN_ONCE_SLUGS.filter(s => signed.has(s) && !kept.includes(s));
  return swapMsaForOnFile(kept, msa, client?.company_name || client?.name || '', alsoSigned);
}

export type CreateProposalInput = {
  client_id: string;
  audit_id?: string | null;
  template_id?: string | null;
  title: string;
  content_blocks?: Proposal['content_blocks'];
  include_contracts?: string[];
  recipient_name?: string;
  recipient_email?: string;
  discount_type?: Proposal['discount_type'];
  discount_value?: number;
  discount_applies_to?: Proposal['discount_applies_to'];
  discount_label?: string | null;
};

export async function createProposal(
  input: CreateProposalInput,
  options: { aiAssisted?: boolean; signerHint?: string | null } = {},
): Promise<Proposal> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id ?? null;
  // Master Services Agreement + Operating Agreement are checked by default; an
  // explicit non-empty selection (e.g. a template's own contracts) wins. A
  // client who already signed the MSA gets the on-file reference instead.
  const contracts = await resolveContractsForClient(
    input.client_id,
    input.include_contracts?.length ? input.include_contracts : DEFAULT_INCLUDED_CONTRACTS,
    undefined,
    { dropSigned: true },
  );
  const { data, error } = await supabase
    .from('proposals')
    .insert({
      client_id: input.client_id,
      audit_id: input.audit_id ?? null,
      template_id: input.template_id ?? null,
      title: input.title,
      content_blocks: input.content_blocks ?? [],
      include_contracts: contracts.include_contracts,
      ...(Object.keys(contracts.overrides).length ? { contract_overrides: contracts.overrides } : {}),
      recipient_name: input.recipient_name ?? '',
      recipient_email: input.recipient_email ?? '',
      ...(input.discount_type ? { discount_type: input.discount_type } : {}),
      ...(input.discount_value != null ? { discount_value: input.discount_value } : {}),
      ...(input.discount_applies_to ? { discount_applies_to: input.discount_applies_to } : {}),
      ...(input.discount_label !== undefined ? { discount_label: input.discount_label } : {}),
      created_by: userId,
    })
    .select(PROPOSAL_LIST_SELECT)
    .single();
  if (error) throw error;
  const proposal = mapProposalRow(data);
  await recordProposalEvent(proposal.id, 'created', options.aiAssisted ? { via: 'ai_assistant' } : {});
  // Sign it on the agency's side straight away so the client receives an
  // already-executed contract. Non-fatal: an unsigned draft is still usable and
  // the detail page offers to sign it.
  try {
    await autoSignNewProposal(proposal.id, options.signerHint ?? null);
  } catch (e) {
    console.error('Could not auto-sign the new proposal', e);
  }
  return proposal;
}

export async function updateProposal(
  id: string,
  updates: Partial<
    Pick<
      Proposal,
      | 'title'
      | 'cover'
      | 'content_blocks'
      | 'include_contracts'
      | 'contracts_snapshot'
      | 'contract_overrides'
      | 'discount_type'
      | 'discount_value'
      | 'discount_applies_to'
      | 'discount_label'
      | 'recipient_name'
      | 'recipient_email'
      | 'recipient2_name'
      | 'recipient2_email'
      | 'valid_until'
      | 'status'
      | 'lost_at'
      | 'lost_reason'
      | 'won_at'
    >
  >,
): Promise<Proposal> {
  const { data, error } = await supabase
    .from('proposals')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(PROPOSAL_LIST_SELECT)
    .single();
  if (error) throw error;
  return mapProposalRow(data);
}

export async function deleteProposal(id: string): Promise<void> {
  const { error } = await supabase.from('proposals').delete().eq('id', id);
  if (error) throw error;
}

export async function markProposalLost(id: string, reason: string | null): Promise<Proposal> {
  const proposal = await updateProposal(id, {
    status: 'lost',
    lost_at: new Date().toISOString(),
    lost_reason: reason,
  });
  await recordProposalEvent(id, 'lost', reason ? { reason } : {});
  return proposal;
}

export async function markProposalWon(id: string): Promise<Proposal> {
  const proposal = await updateProposal(id, {
    status: 'won',
    won_at: new Date().toISOString(),
  });
  await recordProposalEvent(id, 'won', { manual: true });
  return proposal;
}

export async function reopenProposal(id: string): Promise<Proposal> {
  const proposal = await updateProposal(id, {
    status: 'sent',
    lost_at: null,
    lost_reason: null,
  });
  await recordProposalEvent(id, 'reopened');
  return proposal;
}

// ---------------------------------------------------------------------------
// Line items

export async function listProposalLineItems(proposalId: string): Promise<ProposalLineItem[]> {
  const { data, error } = await supabase
    .from('proposal_line_items')
    .select('*')
    .eq('proposal_id', proposalId)
    .order('display_order', { ascending: true });
  if (error) throw error;
  return (data ?? []).map(mapLineItemRow);
}

export type CreateProposalLineItemInput = Omit<ProposalLineItem, 'id' | 'created_at'>;

export async function createProposalLineItems(
  items: CreateProposalLineItemInput[],
): Promise<ProposalLineItem[]> {
  if (items.length === 0) return [];
  const { data, error } = await supabase
    .from('proposal_line_items')
    .insert(items)
    .select('*');
  if (error) throw error;
  return (data ?? []).map(mapLineItemRow);
}

export async function updateProposalLineItem(
  id: string,
  updates: Partial<Omit<ProposalLineItem, 'id' | 'proposal_id' | 'created_at'>>,
): Promise<ProposalLineItem> {
  const { data, error } = await supabase
    .from('proposal_line_items')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return mapLineItemRow(data);
}

export async function deleteProposalLineItem(id: string): Promise<void> {
  const { error } = await supabase.from('proposal_line_items').delete().eq('id', id);
  if (error) throw error;
}

/** Remove several line items in one statement, so it either removes all of
 * them or none, never a random subset. */
export async function deleteProposalLineItems(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase.from('proposal_line_items').delete().in('id', ids);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Sending / public link

function generatePublicToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Ensure a proposal is shareable: generates the public token, freezes the
 * contract snapshot, and flips draft -> sent. Refreshes the contract snapshot on
 * every call while the proposal is unsigned so contract edits reach clients who
 * have not signed yet. The validity clock is NOT started here; see valid_until
 * in proposal_public, which starts it on the client's first view.
 */
export async function markProposalSent(proposal: Proposal): Promise<Proposal> {
  if (proposal.client_signed_at) return proposal;

  const [contractDocs, signatures] = await Promise.all([
    listContractDocuments(),
    listProposalSignatures(proposal.id),
  ]);

  // With two signers the content must freeze at the FIRST client signature,
  // not at client_signed_at (which now means fully signed).
  const hasClientSignature = signatures.some(s => s.role === 'client');

  // Freeze the text the client will actually see: a per-proposal override wins
  // over the shared catalog copy.
  const overrides = proposal.contract_overrides ?? {};
  const snapshot = contractDocs
    .filter(doc => proposal.include_contracts.includes(doc.slug))
    .map(doc => ({
      slug: doc.slug,
      name: doc.name,
      content: overrides[doc.slug]?.trim() ? overrides[doc.slug] : doc.content,
      version_updated_at: doc.updated_at,
    }));

  // valid_until is deliberately NOT set here. The validity window starts when
  // the client actually opens the proposal (proposal_public sets it on the first
  // external view), not when we copy the link, since a link can sit unsent for
  // days. A null valid_until also keeps the hourly expiry job away from it.
  const wasDraft = proposal.status === 'draft';
  const updates: Record<string, unknown> = {
    public_token: proposal.public_token ?? generatePublicToken(),
    updated_at: new Date().toISOString(),
  };
  if (!hasClientSignature) {
    updates.contracts_snapshot = snapshot;
  }
  if (wasDraft) {
    updates.status = 'sent';
    updates.sent_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('proposals')
    .update(updates)
    .eq('id', proposal.id)
    .select(PROPOSAL_LIST_SELECT)
    .single();
  if (error) throw error;

  if (wasDraft) {
    await recordProposalEvent(proposal.id, 'sent', { via: 'link', send_method: 'link' });
  }
  return mapProposalRow(data);
}

/** Extend (or shorten) the valid-until date; un-expires a proposal. */
export async function extendProposalValidity(id: string, validUntil: string): Promise<Proposal> {
  return updateProposal(id, { valid_until: validUntil });
}

// ---------------------------------------------------------------------------
// Public page + signing (edge functions; no session required for the first two)

export type PublicProposalPayload = {
  proposal: Pick<
    Proposal,
    | 'proposal_number'
    | 'title'
    | 'status'
    | 'cover'
    | 'content_blocks'
    | 'include_contracts'
    | 'contracts_snapshot'
    | 'contract_overrides'
    | 'discount_type'
    | 'discount_value'
    | 'discount_applies_to'
    | 'discount_label'
    | 'recipient_name'
    | 'recipient_email'
    | 'recipient2_name'
    | 'recipient2_email'
    | 'valid_until'
    | 'sent_at'
    | 'created_at'
    | 'client_signed_at'
    | 'countersigned_at'
  >;
  client: { company_name: string; website_url: string | null };
  line_items: ProposalLineItem[];
  signatures: Pick<ProposalSignature, 'role' | 'signer_index' | 'signer_name' | 'signature_image' | 'signed_at'>[];
  /** Which signer slot the viewer's token belongs to. */
  signer_index: 1 | 2;
  expired: boolean;
  settings: { cover: Partial<ProposalSettings['cover']> };
};

export async function fetchPublicProposal(
  token: string,
  options: { preview?: boolean } = {},
): Promise<PublicProposalPayload | null> {
  const { data, error } = await supabase.functions.invoke('proposal_public', {
    body: { token, preview: options.preview ?? false },
  });
  if (error) {
    // FunctionsHttpError with 404 means unknown token/draft — treat as not found.
    return null;
  }
  if (data?.ok !== true) return null;
  return data as PublicProposalPayload;
}

export async function signProposalPublic(input: {
  token: string;
  typed_name: string;
  signer_email: string;
  signature_image: string;
  /** The optional lines the client ticked; only the first client signer's choice counts. */
  optional_line_ids?: string[];
}): Promise<{ ok: boolean; code?: string; message?: string }> {
  const { data, error } = await supabase.functions.invoke('proposal_sign', { body: input });
  if (error) {
    // Supabase wraps non-2xx responses; surface the coded errors we return.
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.json();
        return { ok: false, code: body?.error?.code, message: body?.error?.message };
      } catch {
        /* fall through */
      }
    }
    return { ok: false, message: error.message };
  }
  if (data?.ok !== true) {
    return { ok: false, code: data?.error?.code, message: data?.error?.message };
  }
  return { ok: true };
}

export async function countersignProposal(input: {
  proposal_id: string;
  typed_name: string;
  signature_image: string;
  /** Team member the signature belongs to. Defaults to the caller. */
  signer_user_id?: string;
  /** Replace an existing agency signature (rejected once the client has signed). */
  replace?: boolean;
}): Promise<void> {
  const { data, error } = await supabase.functions.invoke('proposal_countersign', { body: input });
  if (error) throw error;
  if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Failed to countersign');
}

// The staff-signer list, the Zak default and the hint matcher now live in
// staff-signers.ts so documents share them instead of keeping a second,
// drifting copy. Re-exported here because proposal code imports them from this
// module in a dozen places.
export type { StaffSigner } from './staff-signers';
export { listStaffSigners, DEFAULT_SIGNER_EMAIL, findSignerByHint, pickDefaultSigner, resolveSigner } from './staff-signers';

/** Store the signed-in user's handwritten signature for reuse on future proposals. */
export async function saveMySignature(signatureImage: string | null): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) throw new Error('Not signed in');
  const { error } = await supabase.from('profiles').update({ signature_image: signatureImage }).eq('id', userId);
  if (error) throw error;
}

/** Sign a freshly created proposal on the agency's behalf so it goes out already
 * executed. Best effort: a proposal that fails to sign is still a valid draft,
 * and the signature block on the detail page offers to sign it. Never emails.
 *
 * `signerHint` lets the caller name someone else ("sign it as Xiomara"), which
 * is what the AI assistant passes through; anything unrecognised falls back to
 * the default signer rather than signing as the wrong person. */
export async function autoSignNewProposal(proposalId: string, signerHint?: string | null): Promise<void> {
  const signers = await listStaffSigners();
  const { signer } = resolveSigner(signers, signerHint);
  if (!signer) return;
  const image = resolveSignatureImage(signer);
  if (!image) return;
  await countersignProposal({
    proposal_id: proposalId,
    typed_name: signer.name,
    signature_image: image,
    signer_user_id: signer.id,
  });
}

export async function sendProposalEmail(input: {
  proposal_id: string;
  recipient_email: string;
  recipient_name?: string;
  recipient2_email?: string;
  recipient2_name?: string;
  message?: string;
  reply_to_emails?: string[];
}): Promise<{ public_token: string; public_token2: string | null; email_status: 'sent' | 'skipped' }> {
  const { data, error } = await supabase.functions.invoke('proposal_send_email', {
    body: { ...input, app_url: publicProposalOrigin() },
  });
  if (error) {
    const context = (error as { context?: Response }).context;
    if (context) {
      try {
        const body = await context.json();
        throw new Error(body?.error?.message ?? error.message);
      } catch (e) {
        if (e instanceof Error && e.message !== error.message) throw e;
      }
    }
    throw error;
  }
  if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Failed to send proposal');
  return {
    public_token: data.public_token,
    public_token2: data.public_token2 ?? null,
    email_status: data.email_status,
  };
}

// ---------------------------------------------------------------------------
// Events & signatures

export async function listProposalEvents(proposalId: string): Promise<ProposalEvent[]> {
  const { data, error } = await supabase
    .from('proposal_events')
    .select('*')
    .eq('proposal_id', proposalId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return attachActorNames((data ?? []) as ProposalEvent[]);
}

export async function recordProposalEvent(
  proposalId: string,
  eventType: ProposalEventType,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return;
  const { error } = await supabase.from('proposal_events').insert({
    proposal_id: proposalId,
    event_type: eventType,
    actor: 'admin',
    actor_user_id: userId,
    metadata,
  });
  if (error) throw error;
}

export async function listProposalSignatures(proposalId: string): Promise<ProposalSignature[]> {
  const { data, error } = await supabase
    .from('proposal_signatures')
    .select('*')
    .eq('proposal_id', proposalId)
    .order('signed_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ProposalSignature[];
}

// ---------------------------------------------------------------------------
// Templates

export async function listProposalTemplates(
  options: { activeOnly?: boolean } = {},
): Promise<ProposalTemplate[]> {
  let query = supabase
    .from('proposal_templates')
    .select('*')
    .order('display_order', { ascending: true })
    .order('name', { ascending: true });
  if (options.activeOnly) {
    query = query.eq('is_active', true);
  }
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as ProposalTemplate[];
}

export async function getProposalTemplate(id: string): Promise<ProposalTemplate | null> {
  const { data, error } = await supabase
    .from('proposal_templates')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as ProposalTemplate | null) ?? null;
}

export async function createProposalTemplate(
  input: Omit<ProposalTemplate, 'id' | 'created_at' | 'updated_at'>,
): Promise<ProposalTemplate> {
  const { data, error } = await supabase
    .from('proposal_templates')
    .insert(input)
    .select('*')
    .single();
  if (error) throw error;
  return data as ProposalTemplate;
}

export async function updateProposalTemplate(
  id: string,
  updates: Partial<Omit<ProposalTemplate, 'id' | 'created_at' | 'updated_at'>>,
): Promise<ProposalTemplate> {
  const { data, error } = await supabase
    .from('proposal_templates')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as ProposalTemplate;
}

export async function deleteProposalTemplate(id: string): Promise<void> {
  const { error } = await supabase.from('proposal_templates').delete().eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Contract documents

export async function listContractDocuments(): Promise<ContractDocument[]> {
  const { data, error } = await supabase
    .from('contract_documents')
    .select('*')
    .order('display_order', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ContractDocument[];
}

/** Turn a document name into a stable slug. Proposals reference contracts by
 * slug, so it is generated once at creation and never changes afterwards. */
function contractSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'contract';
}

/** Add a contract document to the shared catalog. */
export async function createContractDocument(name: string): Promise<ContractDocument> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Give the contract document a name.');

  const existing = await listContractDocuments();
  const base = contractSlugFromName(trimmed);
  // Slugs are unique and permanent, so de-duplicate before inserting.
  let slug = base;
  let n = 2;
  while (existing.some(d => d.slug === slug)) slug = `${base}_${n++}`;

  const displayOrder = existing.reduce((max, d) => Math.max(max, d.display_order), 0) + 10;

  const { data, error } = await supabase
    .from('contract_documents')
    .insert({ slug, name: trimmed, content: '', display_order: displayOrder })
    .select('*')
    .single();
  if (error) throw error;
  return data as ContractDocument;
}

/** Remove a contract document from the catalog. Proposals that already froze it
 * into contracts_snapshot keep their copy. */
export async function deleteContractDocument(id: string): Promise<void> {
  const { error } = await supabase.from('contract_documents').delete().eq('id', id);
  if (error) throw error;
}

export async function updateContractDocument(
  id: string,
  updates: Partial<Pick<ContractDocument, 'name' | 'content' | 'is_active'>>,
): Promise<ContractDocument> {
  const { data, error } = await supabase
    .from('contract_documents')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data as ContractDocument;
}
