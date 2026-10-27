// The ECD app rail's sign-in link (src/lib/hub.ts) comes back to the page it was
// sent from with ?ecd_hub=1&code=... That code belongs to ECD Hub, not to this
// app's own Supabase project, whose client would otherwise try to exchange it as
// its own sign-in. So it is kept for the Hub client and taken off the address
// here, before either client starts: main.tsx imports this module first.

export const HUB_CODE_KEY = 'ecd-hub-proposals-code';

try {
  const here = new URL(window.location.href);
  if (here.searchParams.get('ecd_hub') === '1') {
    // Hub appends its code last, after anything already on the address.
    const code = here.searchParams.getAll('code').pop();
    if (code) window.sessionStorage.setItem(HUB_CODE_KEY, code);
    for (const k of ['ecd_hub', 'code', 'error', 'error_code', 'error_description']) here.searchParams.delete(k);
    window.history.replaceState(window.history.state, '', here.pathname + here.search + here.hash);
  }
} catch {
  // No storage: the rail just asks to sign in again.
}
