import { getAddOnItemsFromLayout } from './addon-highlight';

/** A catalog service's Xero Items, for the one-time and the monthly money. */
export type XeroItemCodes = { one_time: string | null; monthly: string | null };
import { listAuditSections, listRevenueOpportunityTemplates } from './db';
import { parseWebRoadmapDetail, type WebRoadmapRow } from './web-report-details';
import { publicReportOrigin } from './public-origin';
import { supabase } from './supabase';
import { investmentRows, parseMonthly, setupCost } from './web-audit-pricing';
import { addOnHasPricing } from './addon-pricing';
import { isAddOnInvestmentIncluded } from './investment-summary';
import { resolveRevenueOpportunityContent } from './revenue-opportunity-content';
import {
  DEFAULT_INCLUDED_CONTRACTS,
  createProposal,
  createProposalLineItems,
  type CreateProposalLineItemInput,
} from './proposals-db';
import type {
  ProposalBlock,
  Audit,
  Client,
  Proposal,
  ProposalLineItem,
  ProposalTemplate,
  ProposalTemplateLineItem,
  RevenueOpportunityAddOnItem,
} from './types';

/**
 * Snapshot the audit's included, priced add-on items as proposal line items.
 * Presenter/demo-only fields (highlighted, related sections, notes) are dropped.
 */
export function auditAddOnsToLineItems(
  layout: unknown,
  /** template_slug -> Xero revenue bucket, from the line item catalog. */
  serviceKeyBySlug: Map<string, string | null> = new Map(),
  /** template_slug -> the catalog service's Xero Items. */
  itemsBySlug: Map<string, XeroItemCodes> = new Map(),
): Omit<CreateProposalLineItemInput, 'proposal_id'>[] {
  const items = getAddOnItemsFromLayout(layout)
    .filter(item => isAddOnInvestmentIncluded(item) && addOnHasPricing(item))
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));

  return items.map((item: RevenueOpportunityAddOnItem, index) => ({
    template_slug: item.template_slug || null,
    // Coded from the catalog so the Xero draft invoice works without anyone
    // re-picking the account on every line.
    xero_service_key: serviceKeyBySlug.get(item.template_slug ?? '') ?? null,
    xero_item_one_time: itemsBySlug.get(item.template_slug ?? '')?.one_time ?? null,
    xero_item_monthly: itemsBySlug.get(item.template_slug ?? '')?.monthly ?? null,
    name: item.name,
    description: item.description ?? '',
    content: resolveRevenueOpportunityContent(item),
    one_time_price: item.one_time_price != null ? Number(item.one_time_price) : null,
    one_time_label: item.one_time_label?.trim() || null,
    monthly_price: item.monthly_price != null ? Number(item.monthly_price) : null,
    monthly_label: item.monthly_label?.trim() || null,
    image_url: item.image_url ?? null,
    display_order: (index + 1) * 10,
  }));
}

/**
 * Snapshot a web audit's ticked roadmap rows as proposal line items. Setup is
 * priced from hours at the rate the roadmap was built with, so a proposal always
 * quotes what the client already read in the report rather than re-deriving it
 * from today's platform rate. An ongoing cost only becomes a monthly price when
 * it is an actual figure; free text stays a label so nobody invents a retainer.
 */
export function webRoadmapToLineItems(
  sectionDetails: unknown,
  serviceKeyBySlug: Map<string, string | null> = new Map(),
  itemsBySlug: Map<string, XeroItemCodes> = new Map(),
): Omit<CreateProposalLineItemInput, 'proposal_id'>[] {
  const detail = parseWebRoadmapDetail(sectionDetails);
  const rate = detail.hourly_rate ?? 0;

  return investmentRows(detail.rows).map((row: WebRoadmapRow, index) => {
    const oneTime = rate > 0 ? setupCost(row, rate) : null;
    const monthly = parseMonthly(row.ongoing_cost_label);
    const ongoingLabel = (row.ongoing_cost_label ?? '').trim();
    return {
      template_slug: row.template_slug || null,
      // Roadmap work is website work unless its catalog service says otherwise.
      xero_service_key: serviceKeyBySlug.get(row.template_slug ?? '') ?? 'website',
      xero_item_one_time: itemsBySlug.get(row.template_slug ?? '')?.one_time ?? null,
      xero_item_monthly: itemsBySlug.get(row.template_slug ?? '')?.monthly ?? null,
      name: row.item_name,
      description: row.note ?? '',
      content: '',
      one_time_price: oneTime,
      // No hours estimated yet: carry whatever the roadmap showed instead of
      // quoting zero.
      one_time_label: oneTime == null ? (row.setup_cost_label?.trim() || null) : null,
      monthly_price: monthly,
      monthly_label: monthly == null && ongoingLabel && !/^[—-]$/.test(ongoingLabel) ? ongoingLabel : null,
      image_url: null,
      display_order: (index + 1) * 10,
    };
  });
}

/**
 * The blocks every audit-created proposal starts with.
 *
 * Wording lifted verbatim from the parts of the old SMS template that were never
 * SMS-specific, so the voice is unchanged. The service-specific blocks that used
 * to come with it (Why ECD, Scope of Work, Timeline) are deliberately absent: a
 * proposal built from a website audit was arriving with an SMS migration scope
 * and a claim that ECD is a dedicated Klaviyo team, because the code adopted the
 * first active template regardless of what the audit was about.
 */
const BASE_INTRO: ProposalBlock = {
  key: 'intro',
  title: 'Introduction',
  content:
    "Thank you for the opportunity to put this proposal together. Below you'll find the services we're recommending, "
    + "what each one costs, and the terms of the engagement. We've built this based on what we've seen in your account "
    + 'and where we believe the highest-impact opportunities are.',
};

const BASE_TERMS: ProposalBlock = {
  key: 'terms',
  title: 'Terms & Next Steps',
  content:
    "Once this proposal is signed, we'll schedule a kickoff call within 3-5 business days to align on access, "
    + 'timelines, and priorities. One-time fees are invoiced upon signature; monthly retainers begin at kickoff and '
    + 'renew automatically each month. Full terms are covered in the agreements that govern this proposal.',
};

/**
 * A block linking back to the audit the proposal came out of.
 *
 * The client has already read the audit; a proposal that cannot point at it
 * makes them hunt for the email it arrived in. Only built once the audit has a
 * share token, which publishing creates: inventing one here would publish the
 * audit as a side effect of drafting a proposal.
 */
export function auditReportBlock(audit: Audit): ProposalBlock | null {
  const token = (audit.public_share_token ?? '').trim();
  if (!token) return null;
  const url = `${publicReportOrigin()}/report/${token}`;
  const kind = audit.audit_type === 'web' ? 'website audit' : 'Klaviyo audit';
  return {
    key: 'audit_report_link',
    title: 'The audit behind this proposal',
    // Bare URL, no markdown link syntax: the renderer autolinks it and the
    // editor round-trips it untouched.
    content: `Everything proposed here comes out of the ${kind} we walked through together. You can revisit it at any time:\n\n${url}`,
  };
}

/** Create a draft proposal prefilled from an audit's revenue opportunity add-ons. */
export async function createProposalFromAudit(audit: Audit, client: Client): Promise<Proposal> {
  // No template: the proposal is about THIS audit, and adopting an unrelated
  // template's scope and timeline is worse than starting from the shared base.
  const linkBlock = auditReportBlock(audit);
  const proposal = await createProposal({
    client_id: client.id,
    audit_id: audit.id,
    template_id: null,
    title: `Proposal for ${client.company_name}`,
    content_blocks: [
      { ...BASE_INTRO },
      ...(linkBlock ? [linkBlock] : []),
      { ...BASE_TERMS },
    ],
    // The MSA and operating agreement are not service-specific, and the Terms
    // block above refers to them, so dropping the template must not drop these
    // with it. A returning client gets the Statement of Work only (createProposal).
    include_contracts: [...DEFAULT_INCLUDED_CONTRACTS],
    recipient_name: client.name ?? '',
    recipient_email: '',
  });

  // Best effort: if the catalog cannot be read, lines are simply uncoded and the
  // per-line picker is still there. Never block creating the proposal for it.
  const serviceKeyBySlug = new Map<string, string | null>();
  const itemsBySlug = new Map<string, XeroItemCodes>();
  try {
    for (const t of await listRevenueOpportunityTemplates()) {
      if (t.xero_service_key) serviceKeyBySlug.set(t.slug, t.xero_service_key);
      itemsBySlug.set(t.slug, { one_time: t.xero_item_one_time ?? null, monthly: t.xero_item_monthly ?? null });
    }
  } catch { /* leave lines uncoded */ }

  // A web audit prices its work on the roadmap, not on revenue-opportunity
  // add-ons, so reading audit.layout there produced an empty proposal.
  // A web audit prices roadmap work AND any add-ons attached to it, in that
  // order, so the proposal lists what the investment summary totalled.
  const base = audit.audit_type === 'web'
    ? [
        ...webRoadmapToLineItems(
          (await listAuditSections(audit.id)).find(s => s.section_key === 'web_revenue_summary')?.section_details,
          serviceKeyBySlug,
          itemsBySlug,
        ),
        ...auditAddOnsToLineItems(audit.layout, serviceKeyBySlug, itemsBySlug),
      ].map((item, index) => ({ ...item, display_order: (index + 1) * 10 }))
    : auditAddOnsToLineItems(audit.layout, serviceKeyBySlug, itemsBySlug);

  const lineItems = base.map(item => ({ ...item, proposal_id: proposal.id }));
  if (lineItems.length > 0) await createProposalLineItems(lineItems);

  return proposal;
}

export type ProposalDraftResult = { blocks_written: number; block_titles: string[]; questions: string[] };

/**
 * Ask the drafting function to write the scope sections from the audit.
 *
 * Called after creation rather than inside it, because the line items are the
 * scope the narrative describes and they only exist once the proposal does.
 * Returns null on any failure, including a missing API key: a proposal with
 * boilerplate and no scope is still usable, and losing the proposal that was
 * just created would be far worse.
 */
export async function draftProposalFromAudit(
  auditId: string,
  proposalId: string,
): Promise<ProposalDraftResult | null> {
  try {
    const { data, error } = await supabase.functions.invoke('proposal_draft_from_audit', {
      body: { audit_id: auditId, proposal_id: proposalId },
    });
    if (error || !data?.ok) return null;
    return {
      blocks_written: Number(data.blocks_written ?? 0),
      block_titles: Array.isArray(data.block_titles) ? data.block_titles.map(String) : [],
      questions: Array.isArray(data.questions) ? data.questions.map(String) : [],
    };
  } catch {
    return null;
  }
}

/** Create a draft proposal from scratch, optionally seeded from a template. */
export async function createProposalFromTemplate(
  client: Client,
  template: ProposalTemplate | null,
): Promise<Proposal> {
  const proposal = await createProposal({
    client_id: client.id,
    template_id: template?.id ?? null,
    title: `Proposal for ${client.company_name}`,
    content_blocks: template?.content_blocks?.map(b => ({ ...b })) ?? [],
    include_contracts: template?.default_contracts ? [...template.default_contracts] : [],
    recipient_name: client.name ?? '',
    recipient_email: '',
    discount_type: template?.discount_type ?? 'none',
    discount_value: template?.discount_value ?? 0,
    discount_applies_to: template?.discount_applies_to ?? 'one_time',
    discount_label: template?.discount_label ?? null,
  });

  const defaults = template?.default_line_items ?? [];
  if (defaults.length > 0) {
    await createProposalLineItems(
      defaults.map((item, index) => ({
        ...item,
        display_order: (index + 1) * 10,
        proposal_id: proposal.id,
      })),
    );
  }

  return proposal;
}

/** Strip a live proposal line item down to the template-embedded shape. */
function lineItemToTemplateItem(item: ProposalLineItem, index: number): ProposalTemplateLineItem {
  return {
    template_slug: item.template_slug,
    name: item.name,
    description: item.description,
    content: item.content,
    one_time_price: item.one_time_price,
    one_time_label: item.one_time_label,
    monthly_price: item.monthly_price,
    monthly_label: item.monthly_label,
    image_url: item.image_url,
    display_order: (index + 1) * 10,
  };
}

/**
 * Build a template payload from an existing proposal, carrying everything except
 * client-specific info (recipient, client, tokens, status, signatures). Cover is
 * dropped too, since it is driven by global settings rather than per-template.
 */
export function buildTemplateInputFromProposal(
  name: string,
  proposal: Proposal,
  lineItems: ProposalLineItem[],
  displayOrder: number,
): Omit<ProposalTemplate, 'id' | 'created_at' | 'updated_at'> {
  const sorted = [...lineItems].sort((a, b) => a.display_order - b.display_order);
  return {
    name: name.trim(),
    content_blocks: proposal.content_blocks.map(b => ({ ...b })),
    default_line_items: sorted.map(lineItemToTemplateItem),
    default_contracts: [...proposal.include_contracts],
    discount_type: proposal.discount_type,
    discount_value: proposal.discount_value,
    discount_applies_to: proposal.discount_applies_to,
    discount_label: proposal.discount_label,
    is_active: true,
    display_order: displayOrder,
  };
}
