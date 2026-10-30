/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import {
  buildProposalPriceLines,
  computeProposalTotals,
  lineItemHasPricing,
  lineIsTaken,
  proposalPipelineValue,
} from './proposal-pricing';
import type { ProposalLineItem } from './types';

function item(partial: Partial<ProposalLineItem> & Pick<ProposalLineItem, 'name'>): ProposalLineItem {
  return {
    id: partial.id ?? `li-${partial.name}`,
    proposal_id: 'p1',
    template_slug: null,
    description: '',
    content: '',
    one_time_price: null,
    one_time_label: null,
    monthly_price: null,
    monthly_label: null,
    image_url: null,
    display_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
}

describe('buildProposalPriceLines', () => {
  it('emits one line per priced unit and sorts by display order', () => {
    const lines = buildProposalPriceLines([
      item({ name: 'Retainer', monthly_price: 3000, display_order: 20 }),
      item({ name: 'Implementation', one_time_price: 6000, display_order: 10 }),
      item({ name: 'Hybrid', one_time_price: 2500, monthly_price: 1000, display_order: 30 }),
    ]);
    expect(lines.map(l => `${l.name}:${l.unit}`)).toEqual([
      'Implementation:one_time',
      'Retainer:monthly',
      'Hybrid:one_time',
      'Hybrid:monthly',
    ]);
    expect(lines[0].headline).toBe('$6,000');
  });

  it('supports label-only pricing', () => {
    const lines = buildProposalPriceLines([
      item({ name: 'Custom', one_time_label: 'Scoped separately' }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].headline).toBe('Scoped separately');
    expect(lines[0].amount).toBeNull();
  });

  it('skips unpriced items', () => {
    expect(buildProposalPriceLines([item({ name: 'Free' })])).toHaveLength(0);
    expect(lineItemHasPricing(item({ name: 'Free' }))).toBe(false);
  });
});

describe('computeProposalTotals', () => {
  const items = [
    item({ name: 'Implementation', one_time_price: 6000 }),
    item({ name: 'Retainer', monthly_price: 3000 }),
    item({ name: 'Hybrid', one_time_price: 2500, monthly_price: 1000 }),
  ];

  it('sums subtotals per unit without discount', () => {
    const totals = computeProposalTotals(items, null);
    expect(totals.oneTimeSubtotal).toBe(8500);
    expect(totals.monthlySubtotal).toBe(4000);
    expect(totals.oneTimeTotal).toBe(8500);
    expect(totals.monthlyTotal).toBe(4000);
    expect(totals.hasDiscount).toBe(false);
  });

  it('applies a fixed discount only to the selected unit', () => {
    const totals = computeProposalTotals(items, { type: 'fixed', value: 500, appliesTo: 'one_time' });
    expect(totals.oneTimeDiscount).toBe(500);
    expect(totals.oneTimeTotal).toBe(8000);
    expect(totals.monthlyDiscount).toBe(0);
    expect(totals.monthlyTotal).toBe(4000);
  });

  it('applies a percent discount to both units and clamps at 100%', () => {
    const totals = computeProposalTotals(items, { type: 'percent', value: 10, appliesTo: 'both' });
    expect(totals.oneTimeTotal).toBe(7650);
    expect(totals.monthlyTotal).toBe(3600);

    const clamped = computeProposalTotals(items, { type: 'percent', value: 250, appliesTo: 'both' });
    expect(clamped.oneTimeTotal).toBe(0);
    expect(clamped.monthlyTotal).toBe(0);
  });

  it('never lets a fixed discount push a total below zero', () => {
    const totals = computeProposalTotals(items, { type: 'fixed', value: 99999, appliesTo: 'both' });
    expect(totals.oneTimeDiscount).toBe(8500);
    expect(totals.oneTimeTotal).toBe(0);
    expect(totals.monthlyTotal).toBe(0);
  });

  it('flags label-only pricing per unit', () => {
    const totals = computeProposalTotals(
      [item({ name: 'Custom', one_time_label: 'TBD' })],
      null,
    );
    expect(totals.oneTimeHasLabelOnly).toBe(true);
    expect(totals.oneTimeSubtotal).toBe(0);
  });
});

describe('proposalPipelineValue', () => {
  it('values pipeline as one-time + 12x monthly', () => {
    const totals = computeProposalTotals(
      [item({ name: 'A', one_time_price: 1000, monthly_price: 100 })],
      null,
    );
    expect(proposalPipelineValue(totals)).toBe(1000 + 1200);
  });
});

describe('optional lines', () => {
  const base = item({ id: 'a', name: 'Theme work', one_time_price: 2000 });
  const extra = item({ id: 'b', name: 'AfterShip Returns Setup', one_time_price: 1400, optional: true });

  it('count in no total until the client adds them', () => {
    expect(computeProposalTotals([base, extra], null).oneTimeTotal).toBe(2000);
    expect(lineIsTaken(extra)).toBe(false);
  });

  it('count once ticked on the page, before signing', () => {
    expect(computeProposalTotals([base, extra], null, new Set(['b'])).oneTimeTotal).toBe(3400);
  });

  it('follow the choice saved at signing, whatever is ticked', () => {
    expect(computeProposalTotals([base, { ...extra, client_selected: true }], null).oneTimeTotal).toBe(3400);
    expect(computeProposalTotals([base, { ...extra, client_selected: false }], null, new Set(['b'])).oneTimeTotal).toBe(2000);
  });

  it('leave regular lines alone', () => {
    expect(lineIsTaken(base)).toBe(true);
    expect(lineIsTaken({ ...base, client_selected: false })).toBe(true);
  });
});
