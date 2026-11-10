// Pending autosave patches, one per key. The editor debounces saves per key and many edits send only the fields
// they touched (a line item's price, then its label), so a second edit inside the debounce window must ADD to the
// pending save, not replace it: replacing it silently dropped the first edit.

export type PatchQueue<P extends object = Record<string, unknown>> = {
  /** Merge a patch into the one waiting under this key (later fields win). Returns the merged patch. */
  add: (key: string, patch: P) => P;
  /** Remove and return what is waiting under this key, if anything. */
  take: (key: string) => P | undefined;
  /** Drop whatever is waiting under this key (e.g. the line item was deleted). */
  drop: (key: string) => void;
};

export function createPatchQueue<P extends object = Record<string, unknown>>(): PatchQueue<P> {
  const pending = new Map<string, P>();
  return {
    add(key, patch) {
      const merged = { ...(pending.get(key) ?? {}), ...patch } as P;
      pending.set(key, merged);
      return merged;
    },
    take(key) {
      const patch = pending.get(key);
      pending.delete(key);
      return patch;
    },
    drop(key) {
      pending.delete(key);
    },
  };
}
