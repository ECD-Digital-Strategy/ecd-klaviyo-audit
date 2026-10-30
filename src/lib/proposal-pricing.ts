import { formatAddOnPrice, type AddOnPriceUnit } from './addon-pricing';
import { formatCurrency } from './revenue-calculator';
import type {
  Proposal,
  ProposalDiscountAppliesTo,
  ProposalDiscountType,
  ProposalLineItem,
} from './types';

export type ProposalPriceLine = {
  lineItemId: string;
  name: string;
  unit: AddOnPriceUnit;
  amount: number | null;
  label: string | null;
  headline: string;
  caption: string;
  displayOrder: number;
};

export type ProposalDiscountInput = {
  type: ProposalDiscountType;
  value: number;
  appliesTo: ProposalDiscountAppliesTo;
  label?: string | null;
};

export type ProposalTotals = {
  oneTimeSubtotal: number;
  monthlySubtotal: number;
  oneTimeDiscount: number;
  monthlyDiscount: number;
  oneTimeTotal: number;
  monthlyTotal: number;
  oneTimeHasLabelOnly: boolean;
  monthlyHasLabelOnly: boolean;
  hasDiscount: boolean;
};

function hasNumericPrice(amount: number | null | undefined): amount is number {
  return amount != null && Number.isFinite(Number(amount)) && Number(amount) > 0;
}

function hasUnitPricing(amount: number | null | undefined, label: string | null | undefined): boolean {
  return hasNumericPrice(amount) || Boolean(label?.trim());
}

/**
 * A line the client is buying: every regular line, and an optional one they
 * added when signing (or, before signing, ticked on the page: `picked`). An
 * optional line counts in no total until then.
 */
export function lineIsTaken(
  item: Pick<ProposalLineItem, 'id' | 'optional' | 'client_selected'>,
  picked?: ReadonlySet<string>,
): boolean {
  if (!item.optional) return true;
  if (item.client_selected != null) return item.client_selected;
  return picked?.has(item.id) ?? false;
}

export function lineItemHasPricing(item: ProposalLineItem): boolean {
  return (
    hasUnitPricing(item.one_time_price, item.one_time_label) ||
    hasUnitPricing(item.monthly_price, item.monthly_label)
  );
}

/** One display line per priced unit of each line item (an item can yield both a one-time and a monthly line). */
export function buildProposalPriceLines(items: ProposalLineItem[]): ProposalPriceLine[] {
  const sorted = [...items].sort((a, b) => a.display_order - b.display_order);
  const lines: ProposalPriceLine[] = [];

  for (const item of sorted) {
    if (hasUnitPricing(item.one_time_price, item.one_time_label)) {
      const amount = hasNumericPrice(item.one_time_price) ? Number(item.one_time_price) : null;
      const label = item.one_time_label?.trim() || null;
      const { headline, caption } = formatAddOnPrice(amount, label, 'one_time');
      lines.push({
        lineItemId: item.id,
        name: item.name,
        unit: 'one_time',
        amount,
        label,
        headline,
        caption,
        displayOrder: item.display_order,
      });
    }
    if (hasUnitPricing(item.monthly_price, item.monthly_label)) {
      const amount = hasNumericPrice(item.monthly_price) ? Number(item.monthly_price) : null;
      const label = item.monthly_label?.trim() || null;
      const { headline, caption } = formatAddOnPrice(amount, label, 'monthly');
      lines.push({
        lineItemId: item.id,
        name: item.name,
        unit: 'monthly',
        amount,
        label,
        headline,
        caption,
        displayOrder: item.display_order,
      });
    }
  }

  return lines;
}

function computeUnitDiscount(subtotal: number, discount: ProposalDiscountInput, applies: boolean): number {
  if (!applies || discount.type === 'none' || discount.value <= 0 || subtotal <= 0) return 0;
  if (discount.type === 'fixed') return Math.min(discount.value, subtotal);
  const pct = Math.min(Math.max(discount.value, 0), 100);
  return (subtotal * pct) / 100;
}

export function computeProposalTotals(
  items: ProposalLineItem[],
  discount: ProposalDiscountInput | null,
  picked?: ReadonlySet<string>,
): ProposalTotals {
  let oneTimeSubtotal = 0;
  let monthlySubtotal = 0;
  let oneTimeHasLabelOnly = false;
  let monthlyHasLabelOnly = false;

  for (const item of items) {
    if (!lineIsTaken(item, picked)) continue;
    if (hasNumericPrice(item.one_time_price)) oneTimeSubtotal += Number(item.one_time_price);
    else if (item.one_time_label?.trim()) oneTimeHasLabelOnly = true;
    if (hasNumericPrice(item.monthly_price)) monthlySubtotal += Number(item.monthly_price);
    else if (item.monthly_label?.trim()) monthlyHasLabelOnly = true;
  }

  const d = discount ?? { type: 'none' as const, value: 0, appliesTo: 'one_time' as const };
  const oneTimeDiscount = computeUnitDiscount(
    oneTimeSubtotal,
    d,
    d.appliesTo === 'one_time' || d.appliesTo === 'both',
  );
  const monthlyDiscount = computeUnitDiscount(
    monthlySubtotal,
    d,
    d.appliesTo === 'monthly' || d.appliesTo === 'both',
  );

  return {
    oneTimeSubtotal,
    monthlySubtotal,
    oneTimeDiscount,
    monthlyDiscount,
    oneTimeTotal: Math.max(0, oneTimeSubtotal - oneTimeDiscount),
    monthlyTotal: Math.max(0, monthlySubtotal - monthlyDiscount),
    oneTimeHasLabelOnly,
    monthlyHasLabelOnly,
    hasDiscount: oneTimeDiscount > 0 || monthlyDiscount > 0,
  };
}

export function proposalDiscountFromRow(proposal: Proposal): ProposalDiscountInput | null {
  if (proposal.discount_type === 'none' || proposal.discount_value <= 0) return null;
  return {
    type: proposal.discount_type,
    value: Number(proposal.discount_value),
    appliesTo: proposal.discount_applies_to,
    label: proposal.discount_label,
  };
}

export function formatProposalTotal(total: number, hasLabelOnly: boolean): string {
  if (total > 0) return formatCurrency(total);
  if (hasLabelOnly) return 'See line items';
  return formatCurrency(0);
}

/** Pipeline value of an open proposal for KPI cards: one-time total + 12x monthly total. */
export function proposalPipelineValue(totals: ProposalTotals): number {
  return totals.oneTimeTotal + totals.monthlyTotal * 12;
}
