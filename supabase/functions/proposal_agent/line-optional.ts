// Copy of src/lib/line-optional.ts (Deno cannot import src). Keep both in sync.
// A line whose name starts with "Optional" only counts if the client ticks it.

const OPTIONAL_PREFIX = /^\s*[([{]?\s*optional\b/i;

export function impliesOptional(name: string | null | undefined): boolean {
  if (!name) return false;
  return OPTIONAL_PREFIX.test(name);
}
