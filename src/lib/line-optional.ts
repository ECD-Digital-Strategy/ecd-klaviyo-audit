// A proposal line whose name starts with "Optional" (e.g. "Optional: X",
// "Optional - X", "(Optional) X", "Optional add-on: X") is an optional extra:
// it only counts if the client ticks it when signing.
// Mirrored in supabase/functions/proposal_agent/line-optional.ts (Deno cannot import src). Keep both in sync.

const OPTIONAL_PREFIX = /^\s*[([{]?\s*optional\b/i;

export function impliesOptional(name: string | null | undefined): boolean {
  if (!name) return false;
  return OPTIONAL_PREFIX.test(name);
}
