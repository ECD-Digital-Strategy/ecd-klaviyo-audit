import { supabase } from './supabase';
import { resolveSignatureImage } from './signature-image';
import { matchSigner } from './staff-signer-match';

/** Who can sign on ECD's behalf, shared by proposals and documents.
 *
 * The signer is a team member's PROFILE, not the signed-in user: we routinely
 * send something out under a colleague's name. Proposals worked this way from
 * the start; documents used to be able to apply only the current user's own
 * saved signature (user_signatures is RLS-locked to its owner, so another
 * person's was not even readable), which is why this lives here now and both
 * features read the same list.
 *
 * A signer with no drawn signature still works: resolveSignatureImage renders
 * their name in a script face, which is honest about being typed. */
export type StaffSigner = { id: string; name: string; email: string; signature_image: string | null };

/** The team member anything goes out signed by unless someone picks another. */
export const DEFAULT_SIGNER_EMAIL = 'zak@ecdigitalstrategy.com';

// Through staff_signers() (migration 20261028140000), not the profiles table: a
// Member may read only their own profile, so they saw only themselves here and
// could not sign as Zak (Hugo, 2026-10-28).
export async function listStaffSigners(): Promise<StaffSigner[]> {
  const { data, error } = await supabase.rpc('staff_signers');
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(r => ({
    id: String(r.id),
    name: String(r.name ?? ''),
    email: String(r.email ?? ''),
    signature_image: (r.signature_image as string | null) ?? null,
  }));
}

/** The default signer (Zak), falling back to the first team member so a fresh
 * install with no Zak still signs rather than silently skipping. */
export function pickDefaultSigner(signers: StaffSigner[]): StaffSigner | null {
  return signers.find(s => s.email.toLowerCase() === DEFAULT_SIGNER_EMAIL) ?? signers[0] ?? null;
}

/** Resolve a free-text signer hint ("Zak", "zak@ecdigitalstrategy.com", "use
 * Xiomara's signature") to a team member, or null when nothing matches
 * confidently. The matching itself lives in staff-signer-match.ts, free of
 * imports so it can be run and checked on its own. */
export function findSignerByHint(signers: StaffSigner[], hint: string): StaffSigner | null {
  return matchSigner(signers, hint);
}

/** The signer a hint refers to, or the default (Zak) when there is no usable
 * hint. `matched` tells the caller whether the hint actually resolved, so the UI
 * can say "signed as Zak" rather than implying it honoured a name it ignored. */
export function resolveSigner(
  signers: StaffSigner[],
  hint?: string | null,
): { signer: StaffSigner | null; matched: boolean } {
  const hinted = hint ? findSignerByHint(signers, hint) : null;
  if (hinted) return { signer: hinted, matched: true };
  return { signer: pickDefaultSigner(signers), matched: false };
}

/** The image to apply for a signer: their drawing, else their name in script. */
export function signerImage(signer: StaffSigner): string | null {
  return resolveSignatureImage(signer);
}
