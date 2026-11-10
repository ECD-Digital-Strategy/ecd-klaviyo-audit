// Where to send someone back after signing in comes from router state, which a
// crafted link can fill. Only a path on this site counts: "//host" and "/\host"
// are protocol-relative URLs to another site.
const SAME_SITE_PATH = /^\/(?![/\\])/;

/** The value when it is a path on this site, otherwise null. */
export function safeInternalPath(value: unknown): string | null {
  if (typeof value !== 'string' || !SAME_SITE_PATH.test(value)) return null;
  // Control characters (tabs, newlines) are stripped by URL parsers and can hide a "//".
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return null;
  }
  return value;
}
