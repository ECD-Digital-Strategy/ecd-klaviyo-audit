// First: takes the app rail's ECD Hub sign-in code off the address before the app's own client sees it.
import './lib/hubCapture';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { reloadOnceForStaleChunk } from './lib/stale-chunk-reload';

// A tab opened before a deploy asks for page chunks that no longer exist. Reload
// once to pick up the new build; the guard stops a reload loop if it still fails.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadOnceForStaleChunk()) event.preventDefault();
});

// Shopify sometimes opens a client's audit app at its App URL (this site's
// root) after an install, with a signed shop/hmac/host query, instead of
// returning to the OAuth callback. Hand that to the callback, which checks the
// signature and finishes the install that was started for that store.
(() => {
  const params = new URLSearchParams(window.location.search);
  const isShopifyLaunch =
    window.location.pathname === '/' && params.has('hmac') && params.has('shop') && !params.has('code') && !params.has('state');
  const base = (import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '');
  if (isShopifyLaunch && base) {
    window.location.replace(`${base}/functions/v1/shopify_oauth_callback${window.location.search}`);
  }
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
