import { supabase } from './supabase';
import { isImageFile, uploadChatImage } from './chat-image-upload';
import {
  countersignProposal,
  createProposal,
  createProposalLineItems,
  deleteProposalLineItem,
  deleteProposalLineItems,
  recordProposalEvent,
  resolveContractsForClient,
  updateProposal,
  updateProposalLineItem,
} from './proposals-db';
import { listStaffSigners, resolveSigner } from './staff-signers';
import { resolveSignatureImage } from './signature-image';
import type {
  Proposal,
  ProposalAgentAttachment,
  ProposalBlock,
  ProposalDiscountAppliesTo,
  ProposalDiscountType,
  ProposalLineItem,
} from './types';

// ---------------------------------------------------------------------------
// Payload types (mirror supabase/functions/proposal_agent)

export type AgentQuestion = {
  question: string;
  options: Array<{ label: string; value: string }>;
  allow_other: boolean;
  multi_select?: boolean;
  /** Set when several questions were asked at once; the first mirrors the top level. */
  questions?: Array<{ question: string; options: Array<{ label: string; value: string }>; multi_select?: boolean }>;
};

export type AgentDraftLineItem = {
  name: string;
  description: string;
  content: string;
  one_time_price: number | null;
  one_time_label: string | null;
  monthly_price: number | null;
  monthly_label: string | null;
};

export type AgentDiscount = {
  type: ProposalDiscountType;
  value: number;
  applies_to: ProposalDiscountAppliesTo;
  label: string | null;
};

export type ProposalDraftPayload = {
  title: string;
  client_id?: string | null;
  recipient_name?: string | null;
  recipient_email?: string | null;
  content_blocks: Array<{ title: string; content: string }>;
  line_items: AgentDraftLineItem[];
  discount?: AgentDiscount;
  include_contracts?: string[];
  summary: string;
  /** Whose signature signs for ECD, as the user named them. Empty means Zak. */
  agency_signer?: string | null;
};

export type ProposalEditOp =
  | { op: 'update_title'; title: string }
  | { op: 'update_block'; block_key: string; title?: string; content?: string }
  | { op: 'add_block'; after_key?: string | null; title: string; content: string }
  | { op: 'remove_block'; block_key: string }
  | { op: 'add_line_item'; item: AgentDraftLineItem }
  | { op: 'update_line_item'; item_id: string; patch: Partial<AgentDraftLineItem> }
  | { op: 'delete_line_item'; item_id: string }
  | { op: 'update_discount'; discount: AgentDiscount }
  | { op: 'toggle_contract'; slug: string; included: boolean }
  /** Rewrite one contract for THIS proposal only. null clears the override. */
  | { op: 'override_contract'; slug: string; contract_content: string | null }
  | { op: 'update_recipient'; recipient_name?: string; recipient_email?: string }
  | { op: 'set_agency_signer'; signer: string };

export type ProposalEditSet = { summary: string; operations: ProposalEditOp[] };

export type AgentResponse = {
  ok: true;
  conversation_id: string;
  assistant_message_id: string;
  assistant_text: string;
  question?: AgentQuestion;
  draft?: ProposalDraftPayload;
  edits?: ProposalEditSet;
};

export type AgentSnapshot = {
  proposal: {
    id: string;
    title: string;
    status: string;
    content_blocks: ProposalBlock[];
    include_contracts: string[];
    discount_type: string;
    discount_value: number;
    discount_applies_to: string;
    discount_label: string | null;
    recipient_name: string;
    recipient_email: string;
    client_company_name?: string;
  };
  line_items: Array<
    Pick<
      ProposalLineItem,
      | 'id'
      | 'name'
      | 'description'
      | 'content'
      | 'one_time_price'
      | 'one_time_label'
      | 'monthly_price'
      | 'monthly_label'
      | 'display_order'
    >
  >;
};

export class ProposalAgentError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

/** Thrown when the user dismisses the client picker instead of applying a draft. */
export class ApplyCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'ApplyCancelled';
  }
}

// ---------------------------------------------------------------------------
// Copy sanitizing (belt and braces; the edge function sanitizes too)

export function sanitizeCopy(input: string): string {
  if (!input) return input;
  return input
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1-$2')
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/[–—]/g, ', ');
}

// ---------------------------------------------------------------------------
// Invoke

const BLOCK_CONTENT_SNAPSHOT_CAP = 2000;

export function buildSnapshot(proposal: Proposal, lineItems: ProposalLineItem[]): AgentSnapshot {
  return {
    proposal: {
      id: proposal.id,
      title: proposal.title,
      status: proposal.status,
      content_blocks: proposal.content_blocks.map(b => ({
        key: b.key,
        title: b.title,
        content:
          b.content.length > BLOCK_CONTENT_SNAPSHOT_CAP
            ? `${b.content.slice(0, BLOCK_CONTENT_SNAPSHOT_CAP)}\n[truncated]`
            : b.content,
      })),
      include_contracts: proposal.include_contracts,
      discount_type: proposal.discount_type,
      discount_value: proposal.discount_value,
      discount_applies_to: proposal.discount_applies_to,
      discount_label: proposal.discount_label,
      recipient_name: proposal.recipient_name,
      recipient_email: proposal.recipient_email,
      client_company_name: proposal.client?.company_name,
    },
    line_items: lineItems.map(li => ({
      id: li.id,
      name: li.name,
      description: li.description,
      content: li.content,
      one_time_price: li.one_time_price,
      one_time_label: li.one_time_label,
      monthly_price: li.monthly_price,
      monthly_label: li.monthly_label,
      display_order: li.display_order,
    })),
  };
}

/**
 * Upload a file (PDF) for the AI assistant to read. Stored in the public
 * audit-assets bucket so the model can fetch it by URL; returns the attachment
 * descriptor to send with the chat message.
 */
export const MAX_AGENT_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB

export async function uploadProposalAgentFile(
  file: File,
  conversationId: string | null,
): Promise<ProposalAgentAttachment> {
  // Images (screenshots, mostly) go through the shared image path, which
  // downscales before uploading.
  if (isImageFile(file)) {
    return uploadChatImage(file, `proposal-agent/${conversationId ?? 'new'}`);
  }
  if (file.type !== 'application/pdf') {
    throw new Error('Only PDF files and images are supported right now.');
  }
  if (file.size > MAX_AGENT_ATTACHMENT_BYTES) {
    throw new Error('That PDF is too large. Please keep it under 20 MB.');
  }
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'document.pdf';
  const path = `proposal-agent/${conversationId ?? 'new'}/${crypto.randomUUID()}-${safeName}`;
  const { error } = await supabase.storage
    .from('audit-assets')
    .upload(path, file, { upsert: false, contentType: 'application/pdf' });
  if (error) throw error;
  const { data } = supabase.storage.from('audit-assets').getPublicUrl(path);
  return { url: data.publicUrl, name: file.name, media_type: 'application/pdf', size: file.size };
}

export async function sendAgentMessage(input: {
  conversation_id?: string | null;
  proposal_id?: string | null;
  client_id?: string | null;
  message: string;
  attachments?: ProposalAgentAttachment[];
  snapshot?: AgentSnapshot | null;
}): Promise<AgentResponse> {
  const maxAttempts = 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { data, error } = await supabase.functions.invoke<AgentResponse | { ok: false; error: { code: string; message: string } }>(
      'proposal_agent',
      {
        body: {
          conversation_id: input.conversation_id ?? undefined,
          proposal_id: input.proposal_id ?? undefined,
          client_id: input.client_id ?? undefined,
          message: input.message,
          attachments: input.attachments?.length ? input.attachments : undefined,
          snapshot: input.snapshot ?? undefined,
        },
      },
    );
    if (error) {
      lastErr = new ProposalAgentError(error.message || 'Request failed', 'request_failed');
      const retryable = /timeout|504|546|502|503|Failed to send/i.test(error.message ?? '');
      if (retryable && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, 1500 + attempt * 1000));
        continue;
      }
      throw lastErr;
    }
    if (!data || data.ok !== true) {
      const err = (data as { error?: { code?: string; message?: string } })?.error;
      throw new ProposalAgentError(err?.message ?? 'The assistant request failed', err?.code ?? 'request_failed');
    }
    return data;
  }
  throw lastErr instanceof Error ? lastErr : new ProposalAgentError('Request failed', 'request_failed');
}

// ---------------------------------------------------------------------------
// Apply helpers

function blockKey(): string {
  return `block_${Math.random().toString(36).slice(2, 9)}`;
}

/** Create a brand-new proposal from an agent draft. Returns the created proposal. */
export async function applyDraftAsNewProposal(
  draft: ProposalDraftPayload,
  clientId: string,
): Promise<Proposal> {
  const proposal = await createProposal(
    {
      client_id: clientId,
      title: sanitizeCopy(draft.title),
      content_blocks: draft.content_blocks.map(b => ({
        key: blockKey(),
        title: sanitizeCopy(b.title),
        content: sanitizeCopy(b.content),
      })),
      include_contracts: draft.include_contracts ?? [],
      recipient_name: draft.recipient_name ?? '',
      recipient_email: draft.recipient_email ?? '',
    },
    // Auto-signing happens inside createProposal, so the named signer has to go
    // in with it: signing again afterwards would leave two events in the log.
    { aiAssisted: true, signerHint: draft.agency_signer ?? null },
  );

  await createProposalLineItems(
    draft.line_items.map((item, i) => ({
      proposal_id: proposal.id,
      template_slug: null,
      name: sanitizeCopy(item.name),
      description: sanitizeCopy(item.description),
      content: sanitizeCopy(item.content),
      one_time_price: item.one_time_price,
      one_time_label: item.one_time_label ? sanitizeCopy(item.one_time_label) : null,
      monthly_price: item.monthly_price,
      monthly_label: item.monthly_label ? sanitizeCopy(item.monthly_label) : null,
      image_url: null,
      display_order: (i + 1) * 10,
    })),
  );

  if (draft.discount && draft.discount.type !== 'none') {
    await updateProposal(proposal.id, {
      discount_type: draft.discount.type,
      discount_value: draft.discount.value,
      discount_applies_to: draft.discount.applies_to,
      discount_label: draft.discount.label ? sanitizeCopy(draft.discount.label) : null,
    });
  }

  return proposal;
}

export type ApplyEditsResult = { proposal: Proposal; lineItems: ProposalLineItem[] };

/**
 * Apply an agent draft onto a proposal that is already open, replacing its
 * narrative and its line items.
 *
 * The assistant answers a broad rewrite ("draft your own price allocation
 * across the workstreams") with a whole draft rather than a list of edits, and
 * on the editor page that draft had nowhere to go: Apply did nothing at all.
 * Creating a second proposal would be wrong, so the draft lands on the one the
 * user is looking at.
 *
 * Line items are replaced wholesale because a draft restates the full set and
 * carries no ids to match on. Anything the draft leaves out is left alone:
 * a draft says nothing about the recipient or the contracts unless it does.
 */
export async function applyDraftToProposal(
  proposal: Proposal,
  lineItems: ProposalLineItem[],
  draft: ProposalDraftPayload,
): Promise<ApplyEditsResult> {
  // A draft that attaches the template MSA for a client who already signed one
  // gets the on-file reference instead, same as a newly created proposal.
  const contracts = draft.include_contracts
    ? await resolveContractsForClient(proposal.client_id, draft.include_contracts, proposal.id, { dropSigned: true })
    : null;
  const nextProposal = await updateProposal(proposal.id, {
    title: sanitizeCopy(draft.title) || proposal.title,
    content_blocks: draft.content_blocks.map(b => ({
      key: blockKey(),
      title: sanitizeCopy(b.title),
      content: sanitizeCopy(b.content),
    })),
    ...(contracts
      ? {
          include_contracts: contracts.include_contracts,
          contract_overrides: { ...(proposal.contract_overrides ?? {}), ...contracts.overrides },
        }
      : {}),
    ...(draft.recipient_name != null ? { recipient_name: draft.recipient_name } : {}),
    ...(draft.recipient_email != null ? { recipient_email: draft.recipient_email } : {}),
    ...(draft.discount && draft.discount.type !== 'none'
      ? {
          discount_type: draft.discount.type,
          discount_value: draft.discount.value,
          discount_applies_to: draft.discount.applies_to,
          discount_label: draft.discount.label ? sanitizeCopy(draft.discount.label) : null,
        }
      : {}),
  });

  // New items first, then the old ones in a single statement. The first
  // version deleted first, so a failed insert left the proposal with no line
  // items at all. In this order the worst case is a proposal showing both sets,
  // which is visible and fixable, not a lost price list.
  const nextItems = await createProposalLineItems(
    draft.line_items.map((item, i) => ({
      proposal_id: proposal.id,
      template_slug: null,
      name: sanitizeCopy(item.name),
      description: sanitizeCopy(item.description),
      content: sanitizeCopy(item.content),
      one_time_price: item.one_time_price,
      one_time_label: item.one_time_label ? sanitizeCopy(item.one_time_label) : null,
      monthly_price: item.monthly_price,
      monthly_label: item.monthly_label ? sanitizeCopy(item.monthly_label) : null,
      image_url: null,
      display_order: (i + 1) * 10,
    })),
  );
  await deleteProposalLineItems(lineItems.map(li => li.id));

  // Best effort, and last, so a signer problem cannot lose the content.
  if (draft.agency_signer) {
    try {
      const signers = await listStaffSigners();
      const { signer } = resolveSigner(signers, draft.agency_signer);
      const image = signer ? resolveSignatureImage(signer) : null;
      if (signer && image) {
        await countersignProposal({
          proposal_id: proposal.id,
          typed_name: signer.name,
          signature_image: image,
          signer_user_id: signer.id,
          replace: true,
        });
      }
    } catch (e) {
      console.error('Could not change the proposal signer', e);
    }
  }

  return { proposal: nextProposal, lineItems: nextItems };
}

/**
 * Apply an agent edit set against the current proposal state. Computes the
 * final content_blocks / discount / recipient state and writes it in one
 * updateProposal call, then performs line-item inserts/updates/deletes.
 * Returns fresh state for the host page to set.
 */
export async function applyEditSet(
  proposal: Proposal,
  lineItems: ProposalLineItem[],
  editSet: ProposalEditSet,
): Promise<ApplyEditsResult> {
  let blocks: ProposalBlock[] = proposal.content_blocks.map(b => ({ ...b }));
  let title = proposal.title;
  let includeContracts = [...proposal.include_contracts];
  let contractOverrides = { ...(proposal.contract_overrides ?? {}) };
  let recipientName = proposal.recipient_name;
  let recipientEmail = proposal.recipient_email;
  let discount: AgentDiscount | null = null;
  let proposalDirty = false;
  let signerHint: string | null = null;

  let nextItems: ProposalLineItem[] = lineItems.map(li => ({ ...li }));
  const itemInserts: AgentDraftLineItem[] = [];
  const itemUpdates = new Map<string, Partial<AgentDraftLineItem>>();
  const itemDeletes = new Set<string>();

  for (const op of editSet.operations) {
    switch (op.op) {
      case 'update_title':
        title = sanitizeCopy(op.title);
        proposalDirty = true;
        break;
      case 'update_block':
        blocks = blocks.map(b =>
          b.key === op.block_key
            ? {
                ...b,
                ...(op.title != null ? { title: sanitizeCopy(op.title) } : {}),
                ...(op.content != null ? { content: sanitizeCopy(op.content) } : {}),
              }
            : b,
        );
        proposalDirty = true;
        break;
      case 'add_block': {
        const newBlock: ProposalBlock = {
          key: blockKey(),
          title: sanitizeCopy(op.title),
          content: sanitizeCopy(op.content),
        };
        const idx = op.after_key ? blocks.findIndex(b => b.key === op.after_key) : -1;
        if (idx >= 0) blocks.splice(idx + 1, 0, newBlock);
        else blocks.push(newBlock);
        proposalDirty = true;
        break;
      }
      case 'remove_block':
        blocks = blocks.filter(b => b.key !== op.block_key);
        proposalDirty = true;
        break;
      case 'add_line_item':
        itemInserts.push(op.item);
        break;
      case 'update_line_item': {
        const existing = itemUpdates.get(op.item_id) ?? {};
        itemUpdates.set(op.item_id, { ...existing, ...op.patch });
        break;
      }
      case 'delete_line_item':
        itemDeletes.add(op.item_id);
        break;
      case 'update_discount':
        discount = op.discount;
        proposalDirty = true;
        break;
      case 'toggle_contract':
        includeContracts = op.included
          ? [...new Set([...includeContracts, op.slug])]
          : includeContracts.filter(s => s !== op.slug);
        proposalDirty = true;
        break;
      case 'override_contract': {
        const next = { ...contractOverrides };
        if (op.contract_content && op.contract_content.trim()) next[op.slug] = op.contract_content;
        else delete next[op.slug];
        contractOverrides = next;
        proposalDirty = true;
        break;
      }
      case 'update_recipient':
        if (op.recipient_name != null) recipientName = op.recipient_name;
        if (op.recipient_email != null) recipientEmail = op.recipient_email;
        proposalDirty = true;
        break;
      // Re-signing is not a proposal-row edit, so it is collected here and
      // applied after the row updates land.
      case 'set_agency_signer':
        signerHint = op.signer;
        break;
    }
  }

  let nextProposal = proposal;
  if (proposalDirty) {
    nextProposal = await updateProposal(proposal.id, {
      title,
      content_blocks: blocks,
      include_contracts: includeContracts,
      contract_overrides: contractOverrides,
      recipient_name: recipientName,
      recipient_email: recipientEmail,
      ...(discount
        ? {
            discount_type: discount.type,
            discount_value: discount.value,
            discount_applies_to: discount.applies_to,
            discount_label: discount.label ? sanitizeCopy(discount.label) : null,
          }
        : {}),
    });
  }

  for (const [itemId, patch] of itemUpdates) {
    if (itemDeletes.has(itemId)) continue;
    const clean: Record<string, unknown> = {};
    if (patch.name != null) clean.name = sanitizeCopy(patch.name);
    if (patch.description != null) clean.description = sanitizeCopy(patch.description);
    if (patch.content != null) clean.content = sanitizeCopy(patch.content);
    if ('one_time_price' in patch) clean.one_time_price = patch.one_time_price;
    if ('monthly_price' in patch) clean.monthly_price = patch.monthly_price;
    if ('one_time_label' in patch) {
      clean.one_time_label = patch.one_time_label ? sanitizeCopy(patch.one_time_label) : null;
    }
    if ('monthly_label' in patch) {
      clean.monthly_label = patch.monthly_label ? sanitizeCopy(patch.monthly_label) : null;
    }
    if (Object.keys(clean).length === 0) continue;
    const updated = await updateProposalLineItem(itemId, clean);
    nextItems = nextItems.map(li => (li.id === itemId ? updated : li));
  }

  for (const itemId of itemDeletes) {
    await deleteProposalLineItem(itemId);
    nextItems = nextItems.filter(li => li.id !== itemId);
  }

  if (itemInserts.length > 0) {
    const maxOrder = nextItems.reduce((max, li) => Math.max(max, li.display_order), 0);
    const created = await createProposalLineItems(
      itemInserts.map((item, i) => ({
        proposal_id: proposal.id,
        template_slug: null,
        name: sanitizeCopy(item.name),
        description: sanitizeCopy(item.description),
        content: sanitizeCopy(item.content),
        one_time_price: item.one_time_price,
        one_time_label: item.one_time_label ? sanitizeCopy(item.one_time_label) : null,
        monthly_price: item.monthly_price,
        monthly_label: item.monthly_label ? sanitizeCopy(item.monthly_label) : null,
        image_url: null,
        display_order: maxOrder + (i + 1) * 10,
      })),
    );
    nextItems = [...nextItems, ...created];
  }

  // Re-sign for the agency when the user asked for a different signer. Done last
  // so a failure here cannot lose the content edits, and best effort: the
  // signature card on the proposal page can always fix it by hand. The edge
  // function refuses once the client has signed, which is correct, an executed
  // proposal must not change underneath them.
  if (signerHint) {
    try {
      const signers = await listStaffSigners();
      const { signer } = resolveSigner(signers, signerHint);
      const image = signer ? resolveSignatureImage(signer) : null;
      if (signer && image) {
        await countersignProposal({
          proposal_id: proposal.id,
          typed_name: signer.name,
          signature_image: image,
          signer_user_id: signer.id,
          replace: true,
        });
      }
    } catch (e) {
      console.error('Could not change the proposal signer', e);
    }
  }

  // Record AI involvement so the activity log shows the proposal was built or
  // changed with the assistant, even when it was created manually first.
  await recordProposalEvent(proposal.id, 'updated', { via: 'ai_assistant' }).catch(() => {});

  return { proposal: nextProposal, lineItems: nextItems };
}
