/**
 * Browserless (https://browserless.io) headless-browser pass. One /function call
 * renders the page and returns a screenshot (viewport or full-page) plus, for the
 * viewport shot, the real bounding boxes of the page's elements measured at that
 * same render, so findings can pin an actual element instead of a guessed
 * coordinate.
 *
 * When BROWSERLESS_TOKEN is set this replaces ScreenshotOne for web audits
 * entirely (blockAds + blockConsentModals give ad / cookie-banner blocking; we
 * also strip leftover chat widgets and fixed overlays in code, and can click a
 * selector for the cart drawer). ScreenshotOne stays as the fallback when the
 * token is absent or a Browserless call fails.
 */

export type CapturedElement = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Whether this element is (or wraps) a control that hides its content until
   *  tapped, and whether that content is currently open. Read for every
   *  element, because the thing an audit must never do is tell a client to
   *  collapse what is already collapsed, and the element that carries the label
   *  is often a wrapper rather than the button itself. */
  toggle?: "collapsed" | "expanded";
  /** How the element is really painted, for buttons, links and fields only.
   *
   *  An audit told a client to give their "NOT SURE WHAT YOU NEED?" button a
   *  solid green fill and rounded shape. It is a solid green pill. The model was
   *  reading the pale container around it as the button, and the advice was to
   *  add what was already there. Colour, fill and border are cheap to measure
   *  and impossible to argue with, so they are measured. */
  style?: ElementStyle;
};

export type ElementStyle = {
  /** "filled" (a real background), "outlined" (a border and no fill), or
   *  "bare" (neither: text or an icon on the page background). */
  fill: "filled" | "outlined" | "bare";
  /** Background and text colour as the browser computed them. */
  bg: string;
  fg: string;
  /** Corner radius in CSS pixels, so "rounded" is a fact rather than a guess. */
  radius: number;
  /** Border width in CSS pixels. */
  border: number;
  bold: boolean;
  /** Text size in CSS pixels, which is what a "too small to tap" claim rests on. */
  font: number;
  /** Whether this control hides something behind it, and whether that something
   *  is currently open. Absent when the element is not a toggle.
   *
   *  An audit told a client to collapse their "Make it a gift?" option into
   *  something smaller and less prominent. It is a button with
   *  aria-expanded="false" inside an accordion: already collapsed. Advice to
   *  hide what is hidden reads as though nobody looked. */
  toggle?: "collapsed" | "expanded";
};

/** One photograph as it was painted in the shot. Boxes are percentages of the
 * VIEWPORT, so they line up with the primary screenshot the after-image edits.
 * This is a COMPLETE inventory, unlike `elements`, which is a capped, filtered
 * list built for placing finding pins. */
export type CapturedPhoto = {
  src: string;
  /** CSS object-fit, so the compositor knows whether the original pixels can be
   * dropped into a differently-shaped box without distorting them. */
  fit: string;
  /** Intrinsic aspect ratio of the file, when the browser had decoded it. */
  natural_ar: number | null;
  x: number; y: number; w: number; h: number;
};

/** Text that must never change in a generated after: a product title, a price
 * or total, a review count, or the brand mark with its tagline. The compositor
 * locks these the same way it locks photos, because the model kept corrupting
 * exactly this class of content (misspelled titles, invented totals). */
/** Evidence about hover-revealed controls, so an audit never has to guess.
 * A quick-add button that only exists on :hover is invisible to a screenshot,
 * and a report claimed a store had none when it did. */
export type HoverProbe = {
  /** Whether a product card was found and hovered at all. */
  hovered: boolean;
  /** Label of the card that was hovered, for the record. */
  target?: string;
  /** Controls that became visible on hover and were not visible before. */
  revealed: string[];
  /** True when one of the revealed controls is an add-to-cart affordance. */
  quickAdd: boolean;
  /** Why the probe failed, when it did. Recorded rather than swallowed: a null
   * probe reads identically to one that never ran. */
  error?: string;
};

export type CapturedTextLock = {
  kind: string;
  /** The actual text, kept so a lock can be skipped when a fix explicitly
   * targets it, and so corruption is diagnosable from the row. */
  text: string;
  x: number; y: number; w: number; h: number;
};

export type BrowserlessResult =
  | {
    ok: true;
    png: Uint8Array;
    png2?: Uint8Array | null;
    elements: CapturedElement[];
    /** Every photo painted in the shot; drives the after-image compositor. */
    photos: CapturedPhoto[];
    /** Must-not-change text in the shot; the compositor locks these too. */
    textLocks: CapturedTextLock[];
    /** What appeared when a real mouse hovered the first product card. Absent
     * when the probe did not run, EMPTY when it ran and nothing appeared. The
     * difference matters: absent means unknown, empty means checked. */
    hover?: HoverProbe;
    cartCount?: number | null;
    /** The proxy pool that actually served this capture ("" for none). Recorded
     * per snapshot so the datacenter-vs-residential spend is auditable rather
     * than assumed from BROWSERLESS_PROXY. */
    proxyUsed?: string;
    /** Return value of `probeScript` (the DOM outline, when asked for). */
    probe?: unknown;
    /** Return value of `editScript`: which edits actually landed. */
    editReport?: unknown;
    /** Popups that appeared before the sweep removed them. Empty means none
     *  showed while the page was open, not that the store has none. */
    popups?: CapturedPopup[];
    /** How long we waited for placeholder cards to become real products, when
     *  the page had any. Null means the page never showed placeholders. */
    contentWait?: { skeletons_at_start: number; skeletons_at_end: number; waited_ms: number } | null;
    /** Where the slide-cart drawer sat once it stopped moving, and how long that
     *  took. Null when no drawer was opened. */
    cartDrawer?: { left: number | null; width: number | null; coverage: number | null; settled: boolean; waited_ms: number } | null;
  }
  | { ok: false; error: string; proxyUsed?: string };

/** A newsletter or promo modal, as it was before the sweep removed it. */
export type CapturedPopup = {
  text: string;
  /** Percent of the screen it covers: a corner nudge and a wall are different findings. */
  screen_share: number;
  has_email_field: boolean;
  has_close_control: boolean;
  /** The app behind it when its markup names one (klaviyo, privy, attentive...). */
  app: string;
  scroll_locked: boolean;
  when: "on_arrival" | "after_scroll";
};

const DIMENSIONS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

/** What a failed capture means for the next step.
 *  - page_missing / store_password_protected: terminal, no retry, no fallback.
 *  - hopeless: Browserless itself refused (quota, auth); go straight to the fallback.
 *  - blocked: the storefront pushed back; worth the larger residential budget.
 *  - transient: anything else, including a plain 5xx; the normal budget. */
export type CaptureFailureKind = "page_missing" | "store_password_protected" | "hopeless" | "blocked" | "transient";

export function classifyCaptureFailure(error: string): CaptureFailureKind {
  const e = String(error ?? "");
  if (/^store_password_protected/i.test(e)) return "store_password_protected";
  if (/^page_missing/i.test(e)) return "page_missing";
  // Checked before the word lists below: a 5xx body can mention anything.
  if (/^storefront_http_5\d\d/i.test(e)) return "transient";
  if (/http_401|http_402|http_403|units usage|quota|unauthorized|forbidden/i.test(e)) return "hopeless";
  if (/rate.?limited|blocked|verif|challenge|captcha/i.test(e)) return "blocked";
  return "transient";
}

export function browserlessEnabled(): boolean {
  return Boolean((Deno.env.get("BROWSERLESS_TOKEN") ?? "").trim());
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Puppeteer module run inside Browserless. Kept as a plain string so it ships to
// /function as-is. blockAds/blockConsentModals (launch params on the URL) handle
// ads + cookie banners; this code adds a chat-widget / leftover-overlay sweep, an
// optional cart-drawer click, and (for the viewport shot) element-box collection.
// Exported so a test can parse-check it: a syntax error in this string is
// invisible to deno check and surfaces only as every capture failing.
export const FUNCTION_CODE = `
export default async ({ page, context }) => {
  const { url, width, height, fullPage, withElements, hoverProbe, cartAdd, isMobile, secondFold, editScript, probeScript } = context;
  if (editScript) {
    // Must be set before navigation; lets our injected edits run on stores
    // whose CSP would otherwise reject evaluated scripts.
    try { await page.setBypassCSP(true); } catch (e) {}
  }
  // Some storefronts serve a blank page or bot-block the default HeadlessChrome
  // UA at a phone viewport, so emulate a real iPhone (UA + touch) for mobile.
  if (isMobile) {
    try {
      await page.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1");
    } catch (e) {}
    await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  } else {
    // Use a real desktop Chrome UA (not HeadlessChrome) — storefront bot
    // protection blocks the default headless UA on XHRs like /cart/add.js.
    try {
      await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36");
    } catch (e) {}
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
  }
  // networkidle2 is the ideal wait, but plenty of storefronts NEVER reach it:
  // a chat widget, analytics beacon or live-view script keeps connections open
  // indefinitely, and over the slower residential proxy (which every cart
  // capture uses) the 55s ceiling then aborts the whole capture. Power Planter
  // failed exactly this way on every cart attempt while its homepage, captured
  // over the faster datacenter proxy, succeeded.
  //
  // So: ask for idle, and when it times out fall back to "the DOM is ready plus
  // a moment to settle" rather than throwing away a page that is almost
  // certainly rendered. Only a genuine navigation failure (DNS, connection
  // refused, a real block) fails now, and the blocked-page check below still
  // runs either way.
  let resp = null;
  try {
    resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 55000 });
  } catch (navErr) {
    try {
      resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await new Promise((r) => setTimeout(r, 3000));
    } catch (navErr2) {
      throw navErr;
    }
  }

  // Shopify storefronts IP-rate-limit rapid hits by serving a plain-text
  // "local_rate_limited" page (often with a 2xx render), which would otherwise
  // be screenshotted and stored as a "successful" capture. Detect it (and other
  // bare error bodies) and bail out so the caller requeues instead of storing
  // a picture of an error message.
  const httpStatus = resp ? resp.status() : 0;
  const bodyText = await page
    .evaluate(() => ((document.body && document.body.innerText) || "").trim().slice(0, 300))
    .catch(() => "");
  const looksLikeErrorPage =
    bodyText.length < 280 &&
    /local_rate_limited|too many requests|rate.?limited|access denied|error 10\\d\\d|connection needs to be verified|verify you are human|checking your browser|just a moment|attention required|enable javascript and cookies|captcha/i.test(bodyText);
  // Not every failure is a bot block. A store behind its password page, a page
  // that does not exist, and a server error each get their own code, so the
  // caller neither retries the hopeless ones nor spends the bot-block budget on them.
  let finalPath = "";
  try { finalPath = new URL(page.url()).pathname; } catch (e) {}
  if (/\\/password\\/?$/i.test(finalPath)) {
    return { data: { error: "store_password_protected (" + page.url().slice(0, 120) + ")" }, type: "application/json" };
  }
  if (httpStatus === 404 || httpStatus === 410) {
    return { data: { error: "page_missing (http " + httpStatus + ")" }, type: "application/json" };
  }
  // A challenge page can come back as a 503, so only a plain 5xx counts here.
  if (httpStatus >= 500 && !looksLikeErrorPage) {
    return { data: { error: "storefront_http_" + httpStatus + " (" + bodyText.slice(0, 90) + ")" }, type: "application/json" };
  }
  if (httpStatus >= 400 || looksLikeErrorPage) {
    return { data: { error: "storefront_blocked (http " + httpStatus + ": " + bodyText.slice(0, 90) + ")" }, type: "application/json" };
  }

  // Strip leftover fixed overlays that blockConsentModals may miss, plus common
  // live-chat / support launchers so they don't cover real content.
  const sweep = () => {
    const sels = [
      '[id*="cookie" i]','[class*="cookie" i]','[id*="consent" i]','[class*="consent" i]','[class*="gdpr" i]',
      '[id*="intercom" i]','[class*="intercom" i]','[id*="drift" i]','[class*="drift" i]',
      '[class*="tawk" i]','[id*="tawk" i]','[class*="crisp" i]','[id*="crisp" i]',
      '[class*="gorgias" i]','[id*="gorgias" i]','[class*="livechat" i]','[id*="livechat" i]',
      '[aria-label*="chat" i]','[class*="chat-widget" i]','[class*="help-widget" i]'
    ];
    for (const s of sels) {
      document.querySelectorAll(s).forEach((el) => {
        try {
          const cs = getComputedStyle(el);
          if (cs.position === "fixed" || cs.position === "sticky" || Number(cs.zIndex) > 1000) el.remove();
        } catch (e) {}
      });
    }
  };
  // Remove newsletter / promo / email-capture modals + their backdrops so they
  // don't cover the page. NEVER touch cart/drawer elements (the cart capture
  // needs the slide-cart drawer visible).
  const sweepPopups = () => {
    const sels = [
      '[role="dialog"]','[aria-modal="true"]',
      '[class*="modal" i]','[id*="modal" i]','[class*="popup" i]','[id*="popup" i]',
      '[class*="newsletter" i]','[id*="newsletter" i]','[class*="subscribe" i]','[class*="signup" i]',
      '[class*="optin" i]','[class*="email-capture" i]','[class*="lightbox" i]',
      '[class*="klaviyo" i]','[class*="kl-private" i]','[class*="needsclick" i]',
      '[class*="privy" i]','[id*="om-" i]','[class*="justuno" i]','[class*="attentive" i]','[class*="wisepops" i]',
      '[class*="backdrop" i]','[class*="overlay" i]'
    ];
    // A modal is often an inner panel, positioned normally, inside a fixed
    // overlay whose own class matches nothing in the list above. Reading only
    // the matched element's position missed those entirely, so an ancestor
    // within a few levels counts too.
    const floating = (el) => {
      let node = el;
      for (let up = 0; up < 4 && node && node.nodeType === 1; up++, node = node.parentElement) {
        try {
          const cs = getComputedStyle(node);
          if (cs.position === "fixed" || cs.position === "sticky" || Number(cs.zIndex) > 1000) return true;
        } catch (e) { return false; }
      }
      return false;
    };
    for (const s of sels) {
      document.querySelectorAll(s).forEach((el) => {
        try {
          const idc = ((el.getAttribute("class") || "") + " " + (el.id || ""));
          if (/cart|minicart|drawer/i.test(idc)) return; // keep the cart drawer
          if (floating(el)) el.remove();
        } catch (e) {}
      });
    }
  };
  // Look before sweeping.
  //
  // The sweep exists so a newsletter modal does not cover the page in the
  // screenshot, and it works. The cost was that the audit could never see the
  // email capture at all, and nothing stopped it claiming a store had none.
  // This records what was there, in the same page load, so the popup is
  // evidence instead of a blind spot.
  const observePopups = () => {
    const sels = [
      '[role="dialog"]','[aria-modal="true"]',
      '[class*="modal" i]','[id*="modal" i]','[class*="popup" i]','[id*="popup" i]',
      '[class*="newsletter" i]','[class*="subscribe" i]','[class*="signup" i]','[class*="optin" i]',
      '[class*="klaviyo" i]','[class*="kl-private" i]','[class*="privy" i]','[id*="om-" i]',
      '[class*="justuno" i]','[class*="attentive" i]','[class*="wisepops" i]','[class*="omnisend" i]'
    ];
    const APPS = ['klaviyo','privy','justuno','attentive','wisepops','omnisend','mailchimp','sumo','optimonk'];
    const vw = window.innerWidth, vh = window.innerHeight;
    const out = [];
    const seen = [];
    for (const sel of sels) {
      let list = [];
      try { list = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { continue; }
      for (const el of list) {
        try {
          const idc = ((el.getAttribute("class") || "") + " " + (el.id || ""));
          if (/cart|minicart|drawer/i.test(idc)) continue; // the cart drawer is not a popup
          const cs = getComputedStyle(el);
          const floating = cs.position === "fixed" || cs.position === "sticky" || Number(cs.zIndex) > 1000;
          if (!floating) continue;
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          const r = el.getBoundingClientRect();
          // A real popup is a panel, not a one-pixel tracker or a full-page
          // backdrop with nothing in it.
          if (r.width < 180 || r.height < 120) continue;
          const text = (el.innerText || "").trim().replace(/\\s+/g, " ");
          if (text.length < 8) continue;
          if (seen.indexOf(text.slice(0, 60)) !== -1) continue;
          seen.push(text.slice(0, 60));
          const lower = (idc + " " + text).toLowerCase();
          let app = "";
          for (const name of APPS) { if (lower.indexOf(name) !== -1) { app = name; break; } }
          const closeEl = el.querySelector('[aria-label*="close" i], [class*="close" i], button');
          out.push({
            text: text.slice(0, 400),
            // Share of the screen it takes, which is the difference between a
            // corner nudge and a wall the shopper has to get past.
            screen_share: Math.min(100, Math.round(((r.width * r.height) / (vw * vh)) * 100)),
            has_email_field: Boolean(el.querySelector('input[type="email"], input[name*="email" i]')),
            has_close_control: Boolean(closeEl),
            app: app,
            scroll_locked: /hidden|clip/.test(getComputedStyle(document.body).overflow || ""),
          });
          if (out.length >= 4) return out;
        } catch (e) {}
      }
    }
    return out;
  };

  let popups = [];
  try { popups = popups.concat(((await page.evaluate(observePopups)) || []).map((p) => ({ ...p, when: "on_arrival" }))); } catch (e) {}

  await page.evaluate(sweep).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {}); // closes many popups
  await page.evaluate(sweepPopups).catch(() => {});

  // Trigger lazy-loaded media (common on mobile heroes and Shopify sections that
  // load images on scroll) by stepping down the page, then return to the top so
  // the above-the-fold viewport shot is fully painted instead of blank.
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0;
      const step = () => {
        window.scrollTo(0, y);
        y += Math.max(600, window.innerHeight);
        if (y < document.body.scrollHeight && y < 15000) setTimeout(step, 150);
        else { window.scrollTo(0, 0); setTimeout(resolve, 300); }
      };
      step();
    });
  }).catch(() => {});
  // Let images that just entered the viewport decode after scrolling back to top.
  await new Promise((r) => setTimeout(r, 1500));
  // Many newsletter popups fire on a delay / after scroll — dismiss again.
  // Observe first: a popup that waits for the scroll is the common case, and it
  // was the one most thoroughly hidden from the audit.
  try { popups = popups.concat(((await page.evaluate(observePopups)) || []).map((p) => ({ ...p, when: "after_scroll" }))); } catch (e) {}
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(sweepPopups).catch(() => {});

  // Cart: add the product via Shopify's AJAX API (stays on the page), then click
  // a cart trigger. On drawer themes this opens the slide-cart drawer; on
  // page-based themes it navigates to the populated /cart page (we force /cart as
  // a last resort). Either way we get a POPULATED cart, never the checkout the
  // /cart/{variant}:1 permalink would land on.
  let cartCount = null;
  // Geometry of the slide-cart drawer once it stopped moving, kept so a cart
  // shot that looks wrong can be explained rather than guessed at.
  let cartDrawer = null;
  // Whether the shot we are about to take is OF an open slide-cart drawer.
  let drawerOpen = false;
  if (cartAdd) {
    try {
      // 1) Determine a variant to add. Prefer the one we detected; else read a
      //    real variant id off the product page; else pull any available variant.
      let variantId = cartAdd.variantId ? String(cartAdd.variantId) : null;
      if (!variantId && cartAdd.productUrl) {
        try {
          await page.goto(cartAdd.productUrl, { waitUntil: "networkidle2", timeout: 30000 });
          variantId = await page.evaluate(() => {
            const input = document.querySelector('form[action*="/cart/add"] [name="id"], [name="id"]');
            if (input && input.value) return String(input.value);
            try {
              const m = window.ShopifyAnalytics && window.ShopifyAnalytics.meta;
              const v = m && m.product && m.product.variants && m.product.variants[0];
              if (v && v.id) return String(v.id);
            } catch (e) {}
            return null;
          });
        } catch (e) {}
      }
      if (!variantId) {
        variantId = await page.evaluate(async () => {
          try {
            const res = await fetch("/products.json?limit=30");
            const data = await res.json();
            for (const p of (data.products || [])) {
              const v = (p.variants || []).find((x) => x.available) || (p.variants || [])[0];
              if (v && v.id) return String(v.id);
            }
          } catch (e) {}
          return null;
        });
      }

      // 2) Add via the cart PERMALINK, a normal navigation (not an XHR), so
      //    storefront bot protection is far less likely to block it than
      //    /cart/add.js. This lands on /cart with the item in the cart cookie.
      if (variantId) {
        // domcontentloaded, not networkidle2: this permalink commonly redirects
        // to the Shopify CHECKOUT (verified on Power Planter, 2 redirects into
        // /checkouts/cn/...), and a checkout page holds connections open so idle
        // never arrives. We do not screenshot this page at all, we only need the
        // cart cookie it sets, so waiting for the document is enough.
        try { await page.goto(new URL("/cart/" + variantId + ":1", url).href, { waitUntil: "domcontentloaded", timeout: 25000 }); } catch (e) {}
      }
      // Belt-and-suspenders: also try the AJAX add in case the permalink did not stick.
      if (variantId) {
        try {
          await page.evaluate(async (id) => {
            const tryBody = async (body) => {
              try {
                const r = await fetch("/cart/add.js", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify(body) });
                return r.ok;
              } catch (e) { return false; }
            };
            if (await tryBody({ items: [{ id: Number(id), quantity: 1 }] })) return true;
            return await tryBody({ id: Number(id), quantity: 1 });
          }, variantId);
        } catch (e) {}
      }

      // 3) Confirm the cart actually has an item.
      cartCount = await page.evaluate(async () => {
        for (let i = 0; i < 12; i++) {
          try { const c = await (await fetch("/cart.js")).json(); if (c && c.item_count > 0) return c.item_count; } catch (e) {}
          await new Promise((r) => setTimeout(r, 600));
        }
        try { const c = await (await fetch("/cart.js")).json(); return (c && typeof c.item_count === "number") ? c.item_count : -1; } catch (e) { return -1; }
      }).catch(() => -1);

      // 4) Open the slide-cart drawer: go to a NON-cart page (the cart icon lives
      //    in the header there) and click a cart trigger. The item persists via
      //    the cart cookie. Using the storefront root when the configured cart
      //    target is itself /cart matters: a drawer cannot open on the cart page,
      //    which previously left us screenshotting the full /cart page instead.
      let drawerBase = url;
      try {
        const u = new URL(url);
        if (/^\\/cart(\\/|$)/.test(u.pathname)) drawerBase = u.origin + "/";
      } catch (e) {}
      // pageOnly = skip the drawer hunt entirely and screenshot the /cart page.
      // The drawer route costs one navigation plus up to a dozen trigger clicks,
      // each re-navigating when it misses, and that request storm is what makes
      // bot-protected storefronts answer "your connection needs to be verified"
      // (Power Planter did, on every attempt). The permalink plus /cart is two
      // plain navigations and gets a real populated cart, so it is the retry
      // route once the drawer has already failed for this page.
      if (!cartAdd.pageOnly) {
        try { await page.goto(drawerBase, { waitUntil: "networkidle2", timeout: 30000 }); } catch (e) {}
        await page.evaluate(sweep).catch(() => {});
        await page.keyboard.press("Escape").catch(() => {});
        await page.evaluate(sweepPopups).catch(() => {});
      }
      // Prefer drawer-opening toggles (buttons) FIRST; the plain /cart links are
      // last because clicking them navigates to the cart page instead of opening
      // the slide-cart drawer.
      const triggers = [
        '[data-cart-toggle]','.js-drawer-open-cart','[class*="cart-toggle" i]',
        'button[aria-label*="cart" i]','button[class*="cart" i]',
        '#cart-icon-bubble','#CartButton','[data-cart-drawer-toggle]',
        '[class*="cart-icon" i]',
        '[aria-label*="cart" i]','a[href$="/cart"]','a[href*="/cart"]',
      ];

      // On most themes (and on desktop especially) the cart icon is a plain
      // <a href="/cart">: the theme's own JS opens the drawer, but the browser
      // ALSO follows the link, so we ended up on the /cart page. Swallow the
      // link's default action in the capture phase. preventDefault stops the
      // navigation but does NOT stop propagation, so the theme's own click
      // handler still runs and the drawer opens.
      const blockLinkNav = async (on) => {
        await page.evaluate((enable) => {
          if (enable) {
            window.__ecdBlockNav = function (e) {
              const t = e.target;
              const a = t && t.closest ? t.closest("a[href]") : null;
              if (a) e.preventDefault();
            };
            document.addEventListener("click", window.__ecdBlockNav, true);
          } else if (window.__ecdBlockNav) {
            document.removeEventListener("click", window.__ecdBlockNav, true);
            window.__ecdBlockNav = null;
          }
        }, on).catch(() => {});
      };
      // Is a slide-cart drawer actually on screen, and has it stopped moving?
      //
      // Two things went wrong here before. A click alone proves nothing: on many
      // themes the cart icon is a plain <a href="/cart"> that navigates, which
      // used to be accepted as "opened" and gave us the /cart page instead. And
      // once we did look for a panel, any class-matched box overlapping the
      // viewport by four pixels counted, so a drawer still sliding in passed,
      // we waited a flat 700ms and shot. On a phone that produced a cart
      // photographed mid-slide with the homepage still behind it, and the audit
      // then told the client their drawer was "mostly cut off by the screen
      // edge", which was true of our screenshot and not of their store.
      //
      // So the probe below answers both questions at once, and is careful about
      // WHICH box it measures: themes wrap the panel in a full-viewport
      // container that also matches on class and holds the word "cart", and
      // that wrapper sits perfectly still while the panel inside it slides.
      // Measuring the wrapper reads as "fully on screen" instantly. We want the
      // innermost candidate that is positioned out of flow and actually carries
      // the cart's own copy, plus a signature over every candidate so a moving
      // child is never mistaken for a settled parent.
      const drawerProbe = () => page.evaluate(() => {
        const sel = '[class*="drawer" i],[id*="drawer" i],[class*="mini-cart" i],[id*="mini-cart" i],'
          + '[class*="minicart" i],[id*="minicart" i],[class*="cart-modal" i],[class*="cart-popup" i],'
          + 'dialog[open],[role="dialog"],[aria-modal="true"]';
        const vw = window.innerWidth, vh = window.innerHeight;
        const seen = [];
        for (const el of Array.prototype.slice.call(document.querySelectorAll(sel))) {
          const cs = window.getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          if (parseFloat(cs.opacity || "1") < 0.1) continue;
          const r = el.getBoundingClientRect();
          // A real slide panel occupies a meaningful slice of the screen.
          if (r.width < vw * 0.18 || r.height < vh * 0.25) continue;
          seen.push({ el: el, r: r, cs: cs });
        }
        // Geometry of every candidate, still or not, so that a wrapper holding
        // steady cannot mask the panel travelling inside it.
        let sig = "";
        for (const v of seen) {
          sig += Math.round(v.r.left) + ":" + Math.round(v.r.top) + ":" + Math.round(v.r.width) + "|";
        }
        let best = null;
        for (const v of seen) {
          const el = v.el, r = v.r;
          // Skip wrappers: something else we matched lives inside this one.
          let wraps = false;
          for (const o of seen) { if (o.el !== el && el.contains(o.el)) { wraps = true; break; } }
          if (wraps) continue;
          // Drawers are taken out of the document flow, by themselves or by an
          // ancestor. A plain in-flow section is page content, not a drawer.
          let floated = false;
          for (let n = el; n; n = n.parentElement) {
            const p = window.getComputedStyle(n).position;
            if (p === "fixed" || p === "absolute" || p === "sticky") { floated = true; break; }
          }
          if (!floated) continue;
          const txt = ((el.innerText || "") + "").toLowerCase();
          if (!/checkout|subtotal/.test(txt)) continue;
          // How much of the panel's own width is actually inside the screen.
          const shown = Math.max(0, Math.min(vw, r.right) - Math.max(0, r.left));
          const coverage = r.width > 0 ? shown / r.width : 0;
          if (r.right <= 4 || r.left >= vw - 4 || r.bottom <= 4 || r.top >= vh - 4) continue;
          const cand = {
            left: Math.round(r.left),
            width: Math.round(r.width),
            coverage: coverage,
            // Which box we measured, so a wrong pick is diagnosable from the row
            // instead of by re-deriving the page state days later.
            cls: ((el.getAttribute("class") || "") + " " + (el.id || "")).slice(0, 80),
            txt: txt.slice(0, 80),
          };
          if (!best || cand.coverage > best.coverage) best = cand;
        }
        return { sig: sig, best: best };
      }).catch(() => null);

      /** Poll until nothing on screen is moving any more, then report the panel. */
      const settleDrawer = async () => {
        let last = null;
        let stableFor = 0;
        const startedAt = Date.now();
        let latest = null;
        while (Date.now() - startedAt < 4000) {
          const now = await drawerProbe();
          latest = now;
          if (now && last && now.sig === last.sig) {
            stableFor += 1;
            if (stableFor >= 2) return { rect: now.best, ms: Date.now() - startedAt, settled: true };
          } else {
            stableFor = 0;
          }
          last = now;
          await new Promise((r) => setTimeout(r, 180));
        }
        return { rect: latest ? latest.best : null, ms: Date.now() - startedAt, settled: false };
      };

      let opened = false;
      if (!cartAdd.pageOnly) {
      await blockLinkNav(true);
      for (const t of triggers) {
        try {
          // Click the first VISIBLE match, not the first match in the DOM.
          // Themes ship a duplicate of the cart control for the other
          // breakpoint, hidden at the current one: on lazyleaf's DESKTOP header
          // the first a[href="/cart"] in document order is the mobile copy, a
          // 0x0 box at 0,0, so page.$(sel).click() hit nothing, no drawer ever
          // opened, and desktop silently fell back to the /cart page while
          // mobile (where the visible control happens to come first) worked.
          // A real mouse click at the element's centre also exercises the theme
          // the way a shopper does, rather than a synthetic in-page event.
          const box = await page.evaluate((sel) => {
            const nodes = Array.from(document.querySelectorAll(sel));
            for (const el of nodes) {
              const r = el.getBoundingClientRect();
              if (r.width < 6 || r.height < 6) continue;
              if (r.bottom <= 0 || r.top >= window.innerHeight) continue;
              if (r.right <= 0 || r.left >= window.innerWidth) continue;
              const cs = getComputedStyle(el);
              if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
              if (typeof el.checkVisibility === "function" &&
                  !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
            return null;
          }, t);
          if (!box) continue;
          const before = page.url();
          try { await page.mouse.click(box.x, box.y); } catch (e) { continue; }
          await new Promise((r) => setTimeout(r, 2200));
          {
            // Let the slide finish before believing what we can see. The probe
            // reports null when no cart panel is on screen, which is also how a
            // click that merely navigated shows up here.
            const settle = await settleDrawer();
            cartDrawer = {
              left: settle.rect ? settle.rect.left : null,
              width: settle.rect ? settle.rect.width : null,
              coverage: settle.rect ? Math.round(settle.rect.coverage * 100) / 100 : null,
              cls: settle.rect ? settle.rect.cls : null,
              txt: settle.rect ? settle.rect.txt : null,
              settled: settle.settled,
              waited_ms: settle.ms,
            };
            // A panel that has stopped moving and is still hanging off the edge
            // is not a drawer worth photographing. Falling through to the next
            // trigger, and ultimately to the populated /cart page, gives the
            // reader a cart they can actually read.
            if (settle.rect && settle.rect.coverage >= 0.6) {
              opened = true;
              drawerOpen = true;
              await new Promise((r) => setTimeout(r, 400));
              break;
            }
          }
          // The click navigated (typically to /cart) rather than opening a drawer.
          // Return to the page and try the next, more drawer-specific trigger.
          if (page.url() !== before) {
            try { await page.goto(drawerBase, { waitUntil: "networkidle2", timeout: 30000 }); } catch (e) {}
            await page.evaluate(sweep).catch(() => {});
            await page.evaluate(sweepPopups).catch(() => {});
            // A fresh document dropped the listener, so re-arm it.
            await blockLinkNav(true);
          }
        } catch (e) {}
      }
      await blockLinkNav(false);
      }
      // No drawer on this theme (or none would open, or pageOnly asked us not to
      // try): screenshot the populated /cart page so we still show a real cart.
      if (!opened) {
        try { await page.goto(new URL("/cart", url).href, { waitUntil: "networkidle2", timeout: 30000 }); } catch (e) {}
        await page.evaluate(sweep).catch(() => {});
        await page.evaluate(sweepPopups).catch(() => {});
      }
    } catch (e) {}
  }

  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(sweep).catch(() => {});
  // Final popup sweep (keeps the cart drawer; no Escape here so we don't close it).
  await page.evaluate(sweepPopups).catch(() => {});

  // Wait for placeholder cards to become real products.
  //
  // Plenty of storefronts render their grid through a search-and-filter app
  // rather than in the theme, and those ship skeleton cards in the server HTML
  // and swap them for products once their own script answers. The page reaches
  // networkidle2 with the skeletons painted, so the shot went out showing grey
  // blocks and the audit then told the client their category page had "nothing
  // to browse yet", which is a fact about our timing and not their store.
  // Creekside's collection page ships 319 skeleton nodes this way.
  //
  // Counted rather than assumed, and bounded: if the placeholders never clear
  // we shoot the page as it is rather than fail the capture. This runs before
  // the element and photo passes so everything downstream sees one settled
  // page, and it costs nothing on a store that has no placeholders.
  const countSkeletons = () => {
    const sel = '[class*="skeleton" i],[class*="shimmer" i],[class*="animate-pulse" i],[class*="snize-placeholder" i]';
    const vh = window.innerHeight, vw = window.innerWidth;
    let list = [];
    try { list = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { return 0; }
    let n = 0;
    for (const el of list) {
      try {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        // Only what is actually on screen, and only card-sized things: a
        // one-pixel spacer with "skeleton" in its class is not worth waiting on.
        if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
        if (r.width < 24 || r.height < 12) continue;
        n++;
      } catch (e) {}
    }
    return n;
  };

  let contentWait = null;
  try {
    const startSkeletons = await page.evaluate(countSkeletons);
    if (startSkeletons > 0) {
      const startedAt = Date.now();
      let remaining = startSkeletons;
      while (Date.now() - startedAt < 8000) {
        await new Promise((r) => setTimeout(r, 250));
        remaining = await page.evaluate(countSkeletons).catch(() => 0);
        if (remaining === 0) break;
      }
      // Give whatever replaced them a moment to paint and decode.
      if (remaining === 0) await new Promise((r) => setTimeout(r, 600));
      contentWait = {
        skeletons_at_start: startSkeletons,
        skeletons_at_end: remaining,
        waited_ms: Date.now() - startedAt,
      };
    }
  } catch (e) { /* diagnostic only; never fail a capture over it */ }

  let elements = [];
  if (withElements) {
    elements = await page.evaluate(() => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const sel = 'h1,h2,h3,h4,button,a,nav,header,[role="button"],img,input,select,textarea,[class*="cart" i],[class*="hero" i],[class*="cta" i],[class*="banner" i],[class*="search" i],[class*="review" i],[class*="price" i],[class*="badge" i]';
      // Pass 2: short text chips built from plain divs and spans. Themes
      // routinely build category pills, tabs and badges out of non-semantic
      // markup, which pass 1 cannot see by tag or class. Only the innermost
      // node holding the text is taken, so a wrapper does not shadow the chip.
      const chips = [];
      const textNodes = Array.from(document.querySelectorAll("div,span,li,p"));
      for (const el of textNodes) {
        const t = ((el.innerText || "").replace(/\\s+/g, " ")).trim();
        if (!t || t.length > 40) continue;
        if (/[:]$/.test(t)) continue; // "Growing Zone:" and other label stubs
        let shadowed = false;
        for (const c of Array.from(el.children)) {
          if (((c.innerText || "").replace(/\\s+/g, " ")).trim() === t) { shadowed = true; break; }
        }
        if (!shadowed) chips.push(el);
      }
      const tagged = Array.from(document.querySelectorAll(sel));
      const nodes = tagged.concat(chips);
      const seen = [];
      const out = [];
      for (let ni = 0; ni < nodes.length; ni++) {
        const el = nodes[ni];
        const isChip = ni >= tagged.length;
        const r = el.getBoundingClientRect();
        if (r.bottom <= 0 || r.top >= vh) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
        // The checks above read the element's OWN style, and opacity does not
        // inherit into computed style: a child of an opacity:0 popup still
        // reports opacity 1. A hidden cart drawer therefore passed as a real
        // element sitting at the top of the page, and a header finding got
        // pinned to its invisible "GO TO CART" button. checkVisibility accounts
        // for ancestors; the manual walk covers engines without it.
        if (typeof el.checkVisibility === "function") {
          if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) continue;
        } else {
          var hiddenByAncestor = false;
          for (var anc = el.parentElement; anc; anc = anc.parentElement) {
            var acs = getComputedStyle(anc);
            if (acs.visibility === "hidden" || acs.display === "none" || Number(acs.opacity) === 0) { hiddenByAncestor = true; break; }
          }
          if (hiddenByAncestor) continue;
        }
        const left = Math.max(0, r.left), top = Math.max(0, r.top);
        const right = Math.min(vw, r.right), bottom = Math.min(vh, r.bottom);
        const w = right - left, h = bottom - top;
        if (w < 24 || h < 12 || w * h < 700) continue;
        const key = [Math.round(left/8), Math.round(top/8), Math.round(w/8), Math.round(h/8)].join(",");
        const dupeAt = seen.indexOf(key);
        const tag = el.tagName.toLowerCase();
        // innerText = visible text only (skips <style>/<script> content that
        // textContent would leak into labels).
        let text = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("alt") || "").replace(/\\s+/g, " ").trim();
        if (text.indexOf("{") !== -1 && text.indexOf("}") !== -1) text = ""; // leaked CSS
        text = text.slice(0, 60);
        if (!text && tag === "img") text = "image";
        // Open or closed, for anything that toggles. Cheap, and the label is as
        // often on the wrapper as on the button inside it.
        let toggle = null;
        try {
          let marker = el.hasAttribute("aria-expanded") ? el : null;
          if (!marker) marker = el.closest("[aria-expanded]");
          if (!marker) marker = el.querySelector("[aria-expanded]");
          if (marker) {
            toggle = marker.getAttribute("aria-expanded") === "true" ? "expanded" : "collapsed";
          } else {
            const det = tag === "details" ? el : (el.closest("details") || el.querySelector("details"));
            if (det) toggle = det.hasAttribute("open") ? "expanded" : "collapsed";
          }
        } catch (e) { toggle = null; }

        // How it is painted, for the things findings are actually written about.
        let style = null;
        if (tag === "button" || tag === "a" || tag === "input" || tag === "select" || el.getAttribute("role") === "button") {
          try {
            const bg = cs.backgroundColor || "";
            // rgba(...,0) and "transparent" both mean nothing was painted.
            const alpha = (function () {
              const m = bg.match(/rgba?\(([^)]+)\)/);
              if (!m) return bg && bg !== "transparent" ? 1 : 0;
              const parts = m[1].split(",");
              return parts.length > 3 ? parseFloat(parts[3]) : 1;
            })();
            const borderPx = Math.max(
              parseFloat(cs.borderTopWidth || "0") || 0,
              parseFloat(cs.borderLeftWidth || "0") || 0,
            );
            const painted = alpha > 0.05;
            style = {
              fill: painted ? "filled" : (borderPx >= 1 ? "outlined" : "bare"),
              bg: painted ? bg : "none",
              fg: cs.color || "",
              radius: Math.round(parseFloat(cs.borderTopLeftRadius || "0") || 0),
              border: Math.round(borderPx * 10) / 10,
              bold: (parseInt(cs.fontWeight || "400", 10) || 400) >= 600,
              font: Math.round(parseFloat(cs.fontSize || "0") || 0),
            };
            if (toggle) style.toggle = toggle;
          } catch (e) { style = null; }
        }
        const entry = {
          tag, text, chip: isChip, style, toggle,
          x: +(left / vw * 100).toFixed(2), y: +(top / vh * 100).toFixed(2),
          w: +(w / vw * 100).toFixed(2), h: +(h / vh * 100).toFixed(2),
        };
        // Two elements on the same box: keep whichever one has a NAME.
        //
        // This used to keep whichever came first in document order, which is the
        // wrapper. A phone header therefore offered the model "div" where the
        // cart link sat, and the cart's own "icon-cart" label was thrown away as
        // a duplicate. The model can only point at what it can name, an
        // anonymous id is refused downstream on purpose, and the result was a
        // mobile screenshot with no pins on it at all.
        if (dupeAt !== -1) {
          const prev = out[dupeAt];
          if (prev && !prev.text && text) out[dupeAt] = entry;
          continue;
        }
        seen.push(key);
        out.push(entry);
      }
      // Cap each pass separately. A single area-sorted cap would shed exactly
      // the small text chips pass 2 exists to catch, since they are the
      // smallest things on the page.
      const byArea = (a, b) => (b.w * b.h) - (a.w * a.h);
      const kept = out.filter((e) => !e.chip).sort(byArea).slice(0, 60)
        .concat(out.filter((e) => e.chip).sort(byArea).slice(0, 30));
      return kept
        .sort((a, b) => (a.y - b.y) || (a.x - b.x))
        .map((e, i) => {
          const out = { id: "el_" + (i + 1), label: e.tag + (e.text ? ": " + e.text : ""), x: e.x, y: e.y, w: e.w, h: e.h };
          if (e.style) out.style = e.style;
          if (e.toggle) out.toggle = e.toggle;
          return out;
        });
    });
  }

  // Hover the first product card with a REAL mouse and record what appears.
  // Themes hide quick-add behind :hover, which no screenshot can show, and an
  // audit once told a client they had no quick-add when they did. Dispatching
  // mouseover would not do: only a real pointer triggers CSS :hover.
  let hover = null;
  if (hoverProbe) {
    try {
      // Find the first product card: the smallest sensible ancestor of a
      // /products/ link that is big enough to be the card itself.
      const card = await page.evaluate(() => {
        const vw = window.innerWidth, vh = window.innerHeight;
        // NOT simply the first /products/ link on the page: on a live store that
        // was the ANNOUNCEMENT BAR ("NEW SNAKE LEATHER HOODS"), so the probe
        // hovered the top banner, found nothing, and reported the grid had no
        // quick add. Chrome first, then a node that looks like a card.
        const CHROME = 'header,nav,footer,[class*="announcement" i],[class*="menu" i],[class*="drawer" i],[class*="splide" i]';
        const CARD_RE = /(^|[^a-z])card|product-item|product_item|grid-item|grid__item|product-card/i;
        const links = Array.from(document.querySelectorAll('a[href*="/products/"]'))
          .filter((l) => !l.closest(CHROME));
        for (const link of links) {
          let best = null;
          let node = link;
          for (let up = 0; up < 6 && node; up++) {
            const r = node.getBoundingClientRect();
            const onScreen = r.top >= -4 && r.top < vh && r.width > 80 && r.height > 80;
            const stillOneCard = r.width < vw * 0.62 && r.height < vh * 1.6;
            if (onScreen && stillOneCard) {
              const cls = (node.className || "").toString();
              const looksLikeCard = CARD_RE.test(cls);
              const t = ((node.innerText || "").replace(/\\s+/g, " ")).trim();
              // A node the theme itself calls a card wins outright; otherwise
              // take the biggest box that is still one card, since the anchor
              // around the image alone excludes any control under it.
              const better = !best
                || (looksLikeCard && !best.looksLikeCard)
                || (looksLikeCard === best.looksLikeCard && r.width * r.height > best.w * best.h);
              if (better) {
                best = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
                         left: r.left, top: r.top, looksLikeCard: looksLikeCard,
                         label: (t.slice(0, 60) || cls.slice(0, 40) || "product card") };
              }
            }
            node = node.parentElement;
          }
          if (best && best.looksLikeCard) return best;
          if (best) return best;
        }
        return null;
      });

      if (!card) {
        hover = { hovered: false, revealed: [], quickAdd: false };
      } else {
        // Actionable controls visible inside the card's box, before and after.
        const controlsIn = (box) => page.evaluate((b) => {
          const out = [];
          const nodes = Array.from(document.querySelectorAll('button,a,[role="button"],input[type="submit"]'));
          for (const el of nodes) {
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            if (cx < b.left - 4 || cx > b.left + b.w + 4 || cy < b.top - 4 || cy > b.top + b.h + 4) continue;
            if (r.width < 8 || r.height < 8) continue;
            if (typeof el.checkVisibility === "function") {
              if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) continue;
            } else {
              const cs = getComputedStyle(el);
              if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
            }
            const text = ((el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "")
              .replace(/\\s+/g, " ")).trim().slice(0, 60);
            out.push(el.tagName.toLowerCase() + (text ? ": " + text : ""));
          }
          return out;
        }, box);

        const before = await controlsIn(card);
        // Park the mouse away from the grid first, so a control already under
        // the pointer is not counted as revealed by our own hover.
        await page.mouse.move(2, 2);
        await new Promise((r) => setTimeout(r, 150));
        await page.mouse.move(card.x, card.y);
        // Hover transitions are usually 150-300ms; give them room to finish.
        await new Promise((r) => setTimeout(r, 700));
        const after = await controlsIn(card);

        const revealed = after.filter((label) => before.indexOf(label) === -1);
        const ADD_RE = /add to (cart|bag)|quick add|quick shop|quick view|quick buy|add \\+|\\+ add/i;
        hover = {
          hovered: true,
          target: card.label,
          revealed: revealed.slice(0, 8),
          quickAdd: revealed.some((l) => ADD_RE.test(l)),
        };
        // Leave the pointer off the grid so the screenshot is not taken with a
        // card in its hover state, which would misrepresent the resting page.
        await page.mouse.move(2, 2);
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (e) {
      hover = { hovered: false, revealed: [], quickAdd: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  }

  // A COMPLETE inventory of the photographs in the shot, which the elements
  // list above is not: that one exists to place finding pins, so it filters by
  // tag and text and caps itself, and it recorded ONE image on a homepage whose
  // product photos were later swapped, and NONE at all on a product page. The
  // compositor needs every photo or it restores the wrong things. Separate pass,
  // no text filter, pierces shadow roots, and includes CSS background images.
  // Boxes are percentages of the VIEWPORT, matching the primary screenshot.
  // NOTE: this block is inside a template literal sent to Browserless. No
  // backticks and no dollar-brace sequences, or the string terminates here.
  const photos = await page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const out = [];
    const seen = [];
    // Walk light DOM and any open shadow roots: these themes build carousels
    // and gallery slides as web components, which a plain querySelectorAll
    // cannot see into.
    const all = [];
    const walk = (root, depth) => {
      if (depth > 6) return;
      let nodes = [];
      try { nodes = Array.from(root.querySelectorAll("*")); } catch (e) { return; }
      for (const n of nodes) {
        all.push(n);
        if (n.shadowRoot) walk(n.shadowRoot, depth + 1);
      }
    };
    walk(document, 0);

    for (const el of all) {
      const tag = el.tagName ? el.tagName.toLowerCase() : "";
      let src = "";
      let natW = 0, natH = 0;
      if (tag === "img") {
        src = el.currentSrc || el.src || "";
        natW = el.naturalWidth || 0;
        natH = el.naturalHeight || 0;
        // Not decoded yet means nothing is painted there to protect.
        if (!natW || !natH) continue;
      } else {
        let bg = "";
        try { bg = getComputedStyle(el).backgroundImage || ""; } catch (e) { continue; }
        const m = /url\(["']?(.*?)["']?\)/.exec(bg);
        if (!m || !m[1] || /^data:image\/svg/i.test(m[1])) continue;
        src = m[1];
      }
      const r = el.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= vh) continue;
      const left = Math.max(0, r.left), top = Math.max(0, r.top);
      const right = Math.min(vw, r.right), bottom = Math.min(vh, r.bottom);
      const w = right - left, h = bottom - top;
      // Ignore icons and tracking pixels; a real photograph is bigger.
      if (w < 40 || h < 40 || w * h < 4000) continue;
      let cs = null;
      try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
      // A carousel keeps off-screen slides in the DOM at full size; only what is
      // actually painted in the shot matters.
      const key = [Math.round(left / 4), Math.round(top / 4), Math.round(w / 4), Math.round(h / 4)].join(",");
      if (seen.indexOf(key) !== -1) continue;
      seen.push(key);
      out.push({
        src: String(src).slice(0, 400),
        // How the photo is fitted into its box decides whether restoring the
        // original pixels at a different box would distort it.
        fit: (cs.objectFit || "") || (tag === "img" ? "fill" : "cover"),
        natural_ar: natW && natH ? +(natW / natH).toFixed(4) : null,
        x: +(left / vw * 100).toFixed(2), y: +(top / vh * 100).toFixed(2),
        w: +(w / vw * 100).toFixed(2), h: +(h / vh * 100).toFixed(2),
      });
    }
    // Biggest first: if anything has to be dropped it should be the least
    // visually important, and the hero must never be the one that goes.
    return out.sort((a, b) => (b.w * b.h) - (a.w * a.h)).slice(0, 40);
  }).catch(() => []);

  // Text that must never change: product titles, prices and totals, review
  // counts, and the brand mark's tagline. Generated afters kept corrupting
  // exactly these (a title misspelled, a cart total invented, a tagline
  // smeared), so they get the same lock-and-restore treatment as photos, and
  // this inventory is what the compositor locks. Boxes are percentages of the
  // VIEWPORT, matching the primary screenshot.
  // NOTE: inside a template literal sent to Browserless. No backticks and no
  // dollar-brace sequences, or the string terminates here.
  const textLocks = await page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const out = [];
    const seen = [];
    const clean = (s) => (((s || "") + "").replace(/\\s+/g, " ")).trim();
    const digit = (s) => /[0-9]/.test(s);
    const visibleBox = (el) => {
      let cs = null;
      try { cs = getComputedStyle(el); } catch (e) { return null; }
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return null;
      const r = el.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= vh) return null;
      const left = Math.max(0, r.left), top = Math.max(0, r.top);
      const right = Math.min(vw, r.right), bottom = Math.min(vh, r.bottom);
      if (right - left < 8 || bottom - top < 6) return null;
      return { x: left, y: top, w: right - left, h: bottom - top };
    };
    const add = (el, kind, maxChars, maxWFrac, maxHFrac) => {
      const b = visibleBox(el);
      if (!b) return;
      if (b.w > vw * maxWFrac || b.h > vh * maxHFrac) return;
      const text = clean(el.innerText);
      if (!text || text.length > maxChars) return;
      const key = [Math.round(b.x / 6), Math.round(b.y / 6), Math.round(b.w / 6), Math.round(b.h / 6)].join(",");
      if (seen.indexOf(key) !== -1) return;
      seen.push(key);
      out.push({
        kind: kind,
        text: text.slice(0, 80),
        x: +(b.x / vw * 100).toFixed(2), y: +(b.y / vh * 100).toFixed(2),
        w: +(b.w / vw * 100).toFixed(2), h: +(b.h / vh * 100).toFixed(2),
      });
    };
    // Page / product titles.
    const titles = Array.prototype.slice.call(document.querySelectorAll("h1")).slice(0, 2);
    for (const t of titles) add(t, "title", 120, 0.98, 0.2);
    // Prices and totals: the INNERMOST element holding a currency amount, so a
    // whole buy box is never locked just because a price sits inside it.
    const hasMoney = (s) => (s.indexOf("$") !== -1 || s.indexOf("€") !== -1 || s.indexOf("£") !== -1) && digit(s);
    const candidates = Array.prototype.slice.call(document.querySelectorAll("span,div,p,td,dd,strong,b,h2,h3,h4"));
    const prices = [];
    for (const el of candidates) {
      if ((((el.textContent || "") + "").length) > 60) continue; // cheap pre-filter before innerText forces layout
      const t = clean(el.innerText);
      if (!t || t.length > 24 || !hasMoney(t)) continue;
      let innermost = true;
      const kids = Array.prototype.slice.call(el.children);
      for (const k of kids) { if (hasMoney(clean(k.innerText))) { innermost = false; break; } }
      if (innermost) prices.push(el);
    }
    for (const el of prices.slice(0, 10)) add(el, "price", 24, 0.6, 0.08);
    // Review counts and ratings written as text.
    for (const el of candidates) {
      if ((((el.textContent || "") + "").length) > 80) continue;
      const t = clean(el.innerText);
      if (!t || t.length > 40) continue;
      const lower = t.toLowerCase();
      if (lower.indexOf("review") === -1 || !digit(lower)) continue;
      let innermost = true;
      const kids = Array.prototype.slice.call(el.children);
      for (const k of kids) { if (clean(k.innerText).toLowerCase().indexOf("review") !== -1) { innermost = false; break; } }
      if (innermost) add(el, "rating", 40, 0.6, 0.06);
    }
    // The brand mark: the first header link wrapping the logo, INCLUDING any
    // tagline text under it (a smeared tagline shipped on a live audit).
    const headerLinks = Array.prototype.slice.call(document.querySelectorAll("header a"));
    for (const a of headerLinks) {
      if (!a.querySelector("img,svg")) continue;
      add(a, "logo", 80, 0.7, 0.15);
      break;
    }
    return out.slice(0, 12);
  }).catch(() => []);

  // Final guard: cart flow navigates a few times; if any hop landed on a bot
  // challenge / error page, bail so the caller requeues instead of storing a
  // picture of the block. (Real pages have far more than 280 chars of text.)
  const finalText = await page
    .evaluate(() => ((document.body && document.body.innerText) || "").trim().slice(0, 300))
    .catch(() => "");
  if (
    finalText.length < 280 &&
    /local_rate_limited|too many requests|rate.?limited|access denied|error 10\\d\\d|connection needs to be verified|verify you are human|checking your browser|just a moment|attention required|enable javascript and cookies|captcha/i.test(finalText)
  ) {
    return { data: { error: "storefront_blocked (final: " + finalText.slice(0, 90) + ")" }, type: "application/json" };
  }

  // HTML-after mode: apply DOM/CSS edits to the REAL rendered page, then shoot
  // it. Photos, fonts, colors and the logo are the site's own assets, so brand
  // fidelity is by construction rather than by prompt. A failed script returns
  // an error instead of silently shooting the unedited page.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  // Read-only probe of the settled page (a DOM outline, for the HTML-after
  // author). Runs BEFORE any edits so it describes the page as shot, and never
  // fails a capture: a probe that throws just yields no outline.
  let probe = null;
  if (probeScript) {
    try {
      probe = await page.evaluate(new AsyncFunction(probeScript));
    } catch (e) {
      probe = { error: String(e && e.message || e).slice(0, 200) };
    }
  }

  // HTML-after mode: apply DOM/CSS edits to the REAL rendered page, then shoot
  // it. Photos, fonts, colors and the logo are the site's own assets, so brand
  // fidelity is by construction rather than by prompt. The script's return value
  // comes back as editReport, which is how the caller knows each edit actually
  // landed instead of trusting that it did.
  let editReport = null;
  if (editScript) {
    try {
      editReport = await page.evaluate(new AsyncFunction(editScript));
      await new Promise((r) => setTimeout(r, 700));
    } catch (e) {
      return { data: { error: "edit_script_failed: " + String(e && e.message || e).slice(0, 200) }, type: "application/json" };
    }
  }

  // Last look before the shutter.
  //
  // The sweeps above run early, and then the cart flow, the hover probe, the
  // element pass and the DOM probes all take their turn: several seconds in
  // which a delayed popup can appear. One did, on a collection page whose
  // desktop shot went out with a "WANT 10% OFF" modal across it while the
  // observation from moments earlier had recorded nothing. Whatever arrived
  // late is recorded and removed here, so the page in the shot is the page.
  try {
    popups = popups.concat(((await page.evaluate(observePopups)) || []).map((p) => ({ ...p, when: "after_scroll" })));
  } catch (e) { /* observation is a bonus; the removal below is the point */ }
  // Escape is the cheapest way to dismiss a late popup, and on a cart capture
  // it is also how you close a slide-cart drawer. Pressing it here undid the
  // whole drawer flow: the drawer opened, settled, was measured fully on
  // screen, and was then dismissed a moment before the shutter, leaving the
  // homepage with the drawer caught halfway back off the edge. The sweeps below
  // already skip cart elements, so on a drawer shot we sweep without the key.
  if (!drawerOpen) await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(sweepPopups).catch(() => {});
  await page.evaluate(sweep).catch(() => {});

  const screenshot = await page.screenshot({ encoding: "base64", fullPage: !!fullPage, captureBeyondViewport: !!fullPage });

  // Optional second fold: the same page, scrolled down one viewport. Costs one
  // scroll plus a screenshot in this same session (no extra page load, so no
  // extra rate-limit exposure). It is never shown in the report; it gives the
  // "after" image generator the real content that continues below the crop, so
  // it does not invent products or leave an empty band when content shifts up.
  let screenshot2 = null;
  if (secondFold && !fullPage) {
    try {
      await page.evaluate(() => { window.scrollTo(0, window.innerHeight); });
      await new Promise((r) => setTimeout(r, 900));
      await page.evaluate(sweepPopups).catch(() => {});
      const y = await page.evaluate(() => window.scrollY).catch(() => 0);
      // Only useful if the page actually scrolled (short pages have no fold 2).
      if (y > 40) screenshot2 = await page.screenshot({ encoding: "base64" });
      await page.evaluate(() => { window.scrollTo(0, 0); });
    } catch (e) {}
  }
  return { data: { screenshot, screenshot2, elements, photos, textLocks, hover, cartCount, cartDrawer, probe, editReport, popups, contentWait }, type: "application/json" };
};
`;

export async function captureWithBrowserless(input: {
  url: string;
  viewport: "desktop" | "mobile";
  fullPage: boolean;
  withElements: boolean;
  /** When set, add the variant to the cart and open the slide-cart drawer.
   * productUrl lets the capture read a real variant off the product page when no
   * variantId is known. */
  cartAdd?: {
    variantId?: string | null;
    productUrl?: string | null;
    /** Skip the drawer hunt and screenshot the populated /cart page instead.
     * Far fewer requests, so it survives storefronts whose bot protection reacts
     * to the drawer route's click storm. */
    pageOnly?: boolean;
  };
  /** Hover the first product card with a real mouse and record what appears.
   * Only worth doing on pages with a product grid. */
  hoverProbe?: boolean;
  /** Also capture the next viewport down, as context for the "after" generator. */
  secondFold?: boolean;
  /** Which proxy pool to use, when BROWSERLESS_PROXY=auto lets the caller tier
   * them. Datacenter costs a third of residential per MB; residential is the
   * fallback for storefronts that block datacenter traffic. */
  proxyTier?: "datacenter" | "residential";
  /** DOM/CSS edit script (a function body) executed on the rendered page just
   * before the screenshot. This is what turns a capture into an HTML "after":
   * the page is re-shot with the edits applied, so every photo and brand asset
   * stays the site's own. */
  editScript?: string;
  /** Read-only script evaluated on the settled page BEFORE any edits; its return
   * value comes back as `probe`. Used to extract the DOM outline the edit
   * author writes selectors against. */
  probeScript?: string;
  /** Overall time budget. The cart flow chains several navigations (product
   * page, permalink add, drawer) and over a residential proxy it can be doing
   * fine at 90s, so carts pass a bigger budget instead of being aborted
   * mid-flow. */
  timeoutMs?: number;
}): Promise<BrowserlessResult> {
  const token = (Deno.env.get("BROWSERLESS_TOKEN") ?? "").trim();
  if (!token) return { ok: false, error: "browserless_token_missing" };
  const base = (Deno.env.get("BROWSERLESS_BASE_URL") ?? "https://production-sfo.browserless.io").replace(/\/$/, "");
  const dim = DIMENSIONS[input.viewport];
  // The /function endpoint only accepts `token` as a query param (launch flags
  // like blockAds/blockConsentModals are for /screenshot and 400 here). Cookie
  // banners + chat widgets are removed in-code by the sweep() in FUNCTION_CODE.
  const qs = new URLSearchParams({ token });
  // Route through Browserless proxies when enabled. Shopify storefronts
  // rate-limit/block datacenter IPs (the 429 "local_rate_limited" page); a
  // residential IP looks like a normal shopper and gets served, but costs 3x
  // per MB. BROWSERLESS_PROXY values:
  //   residential | datacenter - that pool for every capture
  //   auto - the caller picks per capture via proxyTier (datacenter first,
  //          residential for carts and for retries after a block); with no
  //          tier given, auto falls back to residential, the safe pool.
  const envProxy = (Deno.env.get("BROWSERLESS_PROXY") ?? "").trim();
  const proxy = envProxy === "auto" ? (input.proxyTier ?? "residential") : envProxy;
  if (proxy) {
    qs.set("proxy", proxy);
    qs.set("proxySticky", "true");
    const country = (Deno.env.get("BROWSERLESS_PROXY_COUNTRY") ?? "us").trim();
    if (country) qs.set("proxyCountry", country);
  }

  const ctrl = new AbortController();
  // Residential proxies add latency, so allow more time when one is in use
  // (must exceed the in-page goto timeout + scroll/settle, and stay under the
  // edge runtime wall-clock limit since it's a single attempt per invocation).
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? (proxy ? 90_000 : 45_000));
  try {
    const res = await fetch(`${base}/function?${qs.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: FUNCTION_CODE,
        context: {
          url: input.url,
          width: dim.width,
          height: dim.height,
          fullPage: input.fullPage,
          withElements: input.withElements,
          hoverProbe: Boolean(input.hoverProbe),
          cartAdd: input.cartAdd ?? null,
          isMobile: input.viewport === "mobile",
          secondFold: Boolean(input.secondFold),
          editScript: input.editScript ?? null,
          probeScript: input.probeScript ?? null,
        },
      }),
      signal: ctrl.signal,
    });
    const rawText = await res.text().catch(() => "");
    if (!res.ok) {
      return { ok: false, error: `browserless_http_${res.status}${rawText ? `: ${rawText.slice(0, 140)}` : ""}`, proxyUsed: proxy };
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
    // /function returns the whole { data, type } wrapper as the JSON body, so the
    // real payload is under .data (fall back to the root if that ever changes).
    const wrapper = parsed as { data?: unknown } | null;
    const payload = (wrapper && typeof wrapper.data === "object" ? wrapper.data : wrapper) as
      | {
        screenshot?: string;
        screenshot2?: string | null;
        elements?: CapturedElement[];
        photos?: CapturedPhoto[];
        textLocks?: CapturedTextLock[];
        error?: string;
        cartCount?: number | null;
        hover?: HoverProbe | null;
        probe?: unknown;
        editReport?: unknown;
        popups?: CapturedPopup[];
        contentWait?: { skeletons_at_start: number; skeletons_at_end: number; waited_ms: number } | null;
        cartDrawer?: { left: number | null; width: number | null; coverage: number | null; settled: boolean; waited_ms: number } | null;
      }
      | null;
    // In-page detection (storefront rate-limit / bot-block page) reports a
    // structured error instead of a screenshot.
    if (payload?.error) return { ok: false, error: String(payload.error), proxyUsed: proxy };
    if (!payload?.screenshot) return { ok: false, error: "browserless_no_screenshot", proxyUsed: proxy };
    const png = b64ToBytes(payload.screenshot);
    if (png.byteLength < 5000) return { ok: false, error: "browserless_blank_page", proxyUsed: proxy };
    const elements = Array.isArray(payload.elements) ? payload.elements.slice(0, 90) : [];
    const photos = Array.isArray(payload.photos) ? payload.photos.slice(0, 40) : [];
    const textLocks = Array.isArray(payload.textLocks) ? payload.textLocks.slice(0, 12) : [];
    // Kept null when the probe did not run, so "not checked" never reads as
    // "checked and found nothing".
    const hover: HoverProbe | undefined = payload.hover && typeof payload.hover === "object"
      ? {
        hovered: Boolean(payload.hover.hovered),
        target: typeof payload.hover.target === "string" ? payload.hover.target : undefined,
        revealed: Array.isArray(payload.hover.revealed) ? payload.hover.revealed.map(String).slice(0, 8) : [],
        quickAdd: Boolean(payload.hover.quickAdd),
        error: typeof payload.hover.error === "string" ? payload.hover.error : undefined,
      }
      : undefined;
    let png2: Uint8Array | null = null;
    if (payload.screenshot2) {
      const b = b64ToBytes(payload.screenshot2);
      if (b.byteLength >= 5000) png2 = b;
    }
    return {
      ok: true,
      png,
      png2,
      elements,
      photos,
      textLocks,
      hover,
      cartCount: payload.cartCount ?? null,
      proxyUsed: proxy,
      probe: payload.probe ?? null,
      editReport: payload.editReport ?? null,
      // What the sweep removed, described before it went. Empty array means
      // nothing appeared while the page was open, which is not the same as
      // "this store has no popup": exit-intent and long delays are missed.
      popups: Array.isArray(payload.popups) ? payload.popups : [],
      contentWait: payload.contentWait ?? null,
      cartDrawer: payload.cartDrawer ?? null,
    };
  } catch (e) {
    const msg = e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message))
      ? "browserless_timeout"
      : (e instanceof Error ? e.message : "browserless_failed");
    return { ok: false, error: msg, proxyUsed: proxy };
  } finally {
    clearTimeout(timer);
  }
}
