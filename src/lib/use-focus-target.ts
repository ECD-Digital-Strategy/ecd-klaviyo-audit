import { useEffect, useRef, useState } from 'react';

/**
 * Links in notification emails end in ?focus=<key> (supabase/functions/_shared/
 * app-links.ts). The element that matches scrolls into view and glows for a few
 * seconds, so whoever clicked sees at once where to act (2026-11-04: "redirected
 * to the right page with a pulsing animation on where they need to look").
 * Keys: "welcome" and "xero" on a proposal page, "gmail" in Proposal settings.
 * The parameter is taken off the address afterwards, so a refresh doesn't glow again.
 */
export function useFocusTarget<T extends HTMLElement = HTMLDivElement>(key: string) {
  const [focused] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('focus') === key;
    } catch {
      return false;
    }
  });
  const [glow, setGlow] = useState(false);
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!focused) return;
    // A moment for the page around it to lay out, so it lands in the right place.
    const start = setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setGlow(true);
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('focus');
        window.history.replaceState(window.history.state, '', url.toString());
      } catch {
        // leaving it in the address is harmless
      }
    }, 400);
    const stop = setTimeout(() => setGlow(false), 400 + 9000);
    return () => {
      clearTimeout(start);
      clearTimeout(stop);
    };
  }, [focused]);

  return { ref, focused, glowClass: glow ? 'focus-glow' : '' };
}
