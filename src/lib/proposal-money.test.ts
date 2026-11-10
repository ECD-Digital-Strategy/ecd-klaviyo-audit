import { describe, expect, it } from 'vitest';
import { formatProposalMoney, formatProposalTotal } from './proposal-pricing';

describe('formatProposalMoney', () => {
  it('shows whole dollars when the amount is whole', () => {
    expect(formatProposalMoney(9975)).toBe('$9,975');
  });

  it('shows cents when a discount lands on them', () => {
    expect(formatProposalMoney(8977.5)).toBe('$8,977.50');
    expect(formatProposalMoney(899.991)).toBe('$899.99');
  });

  it('is what proposal totals use', () => {
    expect(formatProposalTotal(1234.56, false)).toBe('$1,234.56');
  });
});
