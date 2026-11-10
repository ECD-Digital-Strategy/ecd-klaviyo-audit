import { describe, expect, it } from 'vitest';
import { buildContractsSnapshot, toggleContractSelection } from './contract-snapshot';

const docs = [
  { slug: 'msa', name: 'MSA', content: 'catalog msa', updated_at: 't1' },
  { slug: 'msa_on_file', name: 'MSA on file', content: '', updated_at: 't2' },
  { slug: 'operating_agreement', name: 'Operating', content: 'catalog op', updated_at: 't3' },
];

describe('buildContractsSnapshot', () => {
  it('keeps catalog order, only included contracts, and prefers an override', () => {
    const snap = buildContractsSnapshot(docs, ['operating_agreement', 'msa_on_file'], { msa_on_file: 'On file since May' });
    expect(snap.map(s => s.slug)).toEqual(['msa_on_file', 'operating_agreement']);
    expect(snap[0].content).toBe('On file since May');
    expect(snap[1].content).toBe('catalog op');
  });

  it('ignores a blank override', () => {
    expect(buildContractsSnapshot(docs, ['msa'], { msa: '  ' })[0].content).toBe('catalog msa');
  });
});

describe('toggleContractSelection', () => {
  it('adds the full MSA and removes either MSA form', () => {
    expect(toggleContractSelection([], 'msa_on_file', true)).toEqual(['msa']);
    expect(toggleContractSelection(['msa_on_file', 'operating_agreement'], 'msa', false)).toEqual(['operating_agreement']);
  });

  it('toggles other contracts by slug without duplicates', () => {
    expect(toggleContractSelection(['msa'], 'msa', true)).toEqual(['msa']);
    expect(toggleContractSelection(['msa'], 'operating_agreement', true)).toEqual(['msa', 'operating_agreement']);
  });
});
