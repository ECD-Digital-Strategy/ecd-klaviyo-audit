/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { MSA_ON_FILE_SLUG, msaOnFileText, swapMsaForOnFile, withoutSignedAgreements, type ExecutedMsa } from './msa-on-file';

const signed: ExecutedMsa = {
  proposalId: 'p1',
  proposalTitle: 'Lane 201 SMS Migration',
  signedAt: '2026-09-22T18:00:00Z',
};

describe('MSA on file', () => {
  it('swaps the template MSA for the on-file reference once one is signed', () => {
    const out = swapMsaForOnFile(['msa', 'operating_agreement'], signed, 'Lane 201');
    expect(out.include_contracts).toEqual([MSA_ON_FILE_SLUG, 'operating_agreement']);
    expect(out.overrides[MSA_ON_FILE_SLUG]).toContain('signed on September 22, 2026');
  });

  it('leaves the first proposal alone', () => {
    expect(swapMsaForOnFile(['msa', 'operating_agreement'], null, 'Lane 201')).toEqual({
      include_contracts: ['msa', 'operating_agreement'],
      overrides: {},
    });
  });

  it('gives a new client the full MSA even if the reference was picked', () => {
    expect(swapMsaForOnFile([MSA_ON_FILE_SLUG, 'operating_agreement'], null, 'New Co').include_contracts).toEqual([
      'msa',
      'operating_agreement',
    ]);
  });

  it('does nothing when the MSA was not selected', () => {
    expect(swapMsaForOnFile(['operating_agreement'], signed, 'Lane 201').include_contracts).toEqual(['operating_agreement']);
  });

  it('names the signed agreement and says it is not amended', () => {
    const text = msaOnFileText(signed, 'Lane 201');
    expect(text).toContain('between ECD Digital Strategy and Lane 201');
    expect(text).toContain('“Lane 201 SMS Migration”');
    expect(text).toContain('nothing in this proposal amends it');
    expect(text).not.toContain('—');
  });
});

describe('Statement of Work only for a returning client', () => {
  const all = ['msa', 'operating_agreement', 'termination_agreement'];

  it('leaves out the Operating and Termination agreements already signed', () => {
    const signed = new Set(all);
    expect(withoutSignedAgreements(all, signed)).toEqual(['msa']);
    // The MSA then becomes the on-file reference, so the proposal is the SOW under it.
    expect(swapMsaForOnFile(withoutSignedAgreements(all, signed), { proposalId: 'p1', proposalTitle: 'First', signedAt: '2026-09-22T18:00:00Z' }, 'Fully Loaded', ['operating_agreement', 'termination_agreement']).include_contracts).toEqual([MSA_ON_FILE_SLUG]);
  });

  it('keeps an agreement the client has not signed yet', () => {
    expect(withoutSignedAgreements(all, new Set(['msa', 'operating_agreement']))).toEqual(['msa', 'termination_agreement']);
  });

  it('gives a new client everything', () => {
    expect(withoutSignedAgreements(all, new Set())).toEqual(all);
  });

  it('says the other signed agreements still apply', () => {
    const text = msaOnFileText({ proposalId: 'p1', proposalTitle: 'First', signedAt: '2026-09-22T18:00:00Z' }, 'Fully Loaded', ['operating_agreement', 'termination_agreement']);
    expect(text).toContain('the Client Operating Rules (Operating Agreement) and the Termination & Transition Agreement');
    expect(text).toContain('also apply to this Statement of Work');
    expect(text).not.toContain('—');
  });
});
