// The contract text a client reads is frozen into proposals.contracts_snapshot. Every path that changes the
// contracts (the manual editor, the assistant's edits and drafts, sending) builds it here so they cannot drift.
// Mirrors the snapshot built in supabase/functions/proposal_send_email.
import { MSA_ON_FILE_SLUG, MSA_SLUG } from './msa-on-file';
import type { ContractDocument, ProposalContractSnapshot } from './types';

/** Catalog order, only the included contracts, and a per-proposal override wins over the catalog text. */
export function buildContractsSnapshot(
  docs: Pick<ContractDocument, 'slug' | 'name' | 'content' | 'updated_at'>[],
  includeContracts: string[],
  overrides: Record<string, string> | null | undefined,
): ProposalContractSnapshot[] {
  const o = overrides ?? {};
  return docs
    .filter(d => includeContracts.includes(d.slug))
    .map(d => ({
      slug: d.slug,
      name: d.name,
      content: o[d.slug]?.trim() ? o[d.slug] : d.content,
      version_updated_at: d.updated_at,
    }));
}

/** Tick or untick one contract. The MSA is one choice with two forms (the full agreement or the short "on file"
 * reference): ticking it adds the full MSA, which resolveContractsForClient then swaps for the reference when the
 * client already signed one; unticking removes whichever form is attached. */
export function toggleContractSelection(current: string[], slug: string, included: boolean): string[] {
  const isMsa = slug === MSA_SLUG || slug === MSA_ON_FILE_SLUG;
  return included
    ? [...new Set([...current, isMsa ? MSA_SLUG : slug])]
    : current.filter(s => (isMsa ? s !== MSA_SLUG && s !== MSA_ON_FILE_SLUG : s !== slug));
}
