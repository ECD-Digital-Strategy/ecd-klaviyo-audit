const RELOAD_KEY = 'ecd_stale_chunk_reload_at';
// One automatic reload per this window; after that the error boundary offers a button.
const GUARD_MS = 60_000;

/** Reloads the page unless it already did so in the last minute. True when a reload was started. */
export function reloadOnceForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (last && Date.now() - last < GUARD_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // No sessionStorage means no loop guard, so do not reload automatically.
    return false;
  }
  window.location.reload();
  return true;
}
