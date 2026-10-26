// A client signs the Master Services Agreement once. Later proposals for the
// same client are Statements of Work under that signed MSA, so they attach a
// short "MSA on file" reference instead of the full template again. Resending
// the template looked like an attempt to swap in new terms, especially for
// clients who negotiated redlines to the original (Zak, 2026-09-25).

export const MSA_SLUG = 'msa';
export const MSA_ON_FILE_SLUG = 'msa_on_file';

/** The other agreements a client signs once (Zak, 2026-10-26): the Operating
 * Agreement (Client Operating Rules) and the Termination & Transition
 * Agreement. Like the MSA, later proposals do not attach them again. */
export const SIGN_ONCE_SLUGS = ['operating_agreement', 'termination_agreement'] as const;

const SIGN_ONCE_NAMES: Record<string, string> = {
  operating_agreement: 'the Client Operating Rules (Operating Agreement)',
  termination_agreement: 'the Termination & Transition Agreement',
};

export type ExecutedMsa = {
  proposalId: string;
  proposalTitle: string;
  signedAt: string;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** The reference text frozen into the proposal in place of the full MSA. */
export function msaOnFileText(msa: ExecutedMsa, clientName: string, alsoSigned: string[] = []): string {
  const client = clientName.trim() || 'Client';
  const others = alsoSigned.map(s => SIGN_ONCE_NAMES[s]).filter(Boolean);
  return [
    '**Governing Agreement**',
    '',
    `This proposal is a Statement of Work under the Master Services Agreement between ECD Digital Strategy and ${client}, ` +
      `signed on ${formatDate(msa.signedAt)} with the proposal “${msa.proposalTitle.trim()}”, as that agreement was executed, ` +
      'including any changes the parties agreed to at the time (the “MSA”).',
    '',
    'The MSA governs this Statement of Work. It is not restated here, and nothing in this proposal amends it.',
    // The other agreements signed with it still apply, and are not attached again.
    ...(others.length
      ? [
          '',
          `${others.join(' and ')}, as signed with the MSA, also ${others.length === 1 ? 'applies' : 'apply'} to this ` +
            `Statement of Work and ${others.length === 1 ? 'is' : 'are'} not restated here.`,
        ]
      : []),
  ].join('\n');
}

/**
 * Contracts to attach for a client. When the client already signed an MSA and
 * the selection includes the template MSA, it is swapped for the on-file
 * reference and the reference text is returned as the override for it.
 */
export function swapMsaForOnFile(
  contracts: string[],
  msa: ExecutedMsa | null,
  clientName: string,
  /** Sign-once agreements the client also signed, named in the reference. */
  alsoSigned: string[] = [],
): { include_contracts: string[]; overrides: Record<string, string> } {
  // The reference means nothing without a signed MSA behind it: a new client
  // always gets the full agreement.
  if (!msa) {
    const include_contracts = [...new Set(contracts.map((s) => (s === MSA_ON_FILE_SLUG ? MSA_SLUG : s)))];
    return { include_contracts, overrides: {} };
  }
  if (!contracts.includes(MSA_SLUG)) return { include_contracts: contracts, overrides: {} };
  const include_contracts = [...new Set(contracts.map((s) => (s === MSA_SLUG ? MSA_ON_FILE_SLUG : s)))];
  return { include_contracts, overrides: { [MSA_ON_FILE_SLUG]: msaOnFileText(msa, clientName, alsoSigned) } };
}

/**
 * Leave out the agreements this client already signed on an earlier proposal
 * (Zak, 2026-10-26): once the Operating Agreement or the Termination &
 * Transition Agreement is signed, later proposals carry the Statement of Work
 * only. The MSA is handled by swapMsaForOnFile, which keeps the short
 * reference that makes the proposal a Statement of Work under the MSA.
 */
export function withoutSignedAgreements(contracts: string[], signed: Set<string>): string[] {
  return contracts.filter(s => !((SIGN_ONCE_SLUGS as readonly string[]).includes(s) && signed.has(s)));
}
