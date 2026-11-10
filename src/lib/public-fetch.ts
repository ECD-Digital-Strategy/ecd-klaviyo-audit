// Public links (report, proposal, document) are fetched through edge functions.
// Only a real "not found" may read as a dead link; anything else (5xx, network,
// timeout) is a retryable error, so a backend hiccup no longer tells a client
// their link has expired.

export const PUBLIC_LOAD_ERROR_MESSAGE = "Couldn't load this right now. Please try again in a moment.";

export class PublicLoadError extends Error {
  readonly retryable = true;
  constructor(message = PUBLIC_LOAD_ERROR_MESSAGE) {
    super(message);
    this.name = 'PublicLoadError';
  }
}

// 400 is a missing or malformed token, which no retry will fix.
const NOT_FOUND_STATUSES = new Set([400, 404]);
const NOT_FOUND_CODES = new Set(['not_found', 'bad_request']);

/** Turns a functions.invoke result into the ok body, null for not found, or a thrown PublicLoadError. */
export function resolvePublicInvoke<T>(data: unknown, error: unknown): T | null {
  if (error) {
    const status = (error as { context?: { status?: unknown } }).context?.status;
    if (typeof status === 'number' && NOT_FOUND_STATUSES.has(status)) return null;
    throw new PublicLoadError();
  }
  const body = data as { ok?: unknown; error?: { code?: unknown } } | null | undefined;
  if (body?.ok === true) return body as T;
  const code = body?.error?.code;
  if (typeof code === 'string' && NOT_FOUND_CODES.has(code)) return null;
  throw new PublicLoadError();
}
