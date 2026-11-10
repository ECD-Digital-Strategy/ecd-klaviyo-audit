import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { hasCronSecret, isServiceRoleAuthorization, requireStaffUserId } from "../_shared/auth.ts";
import { getScreenshotProvider } from "../_shared/screenshot-provider.ts";
import {
  browserlessEnabled,
  captureWithBrowserless,
  classifyCaptureFailure,
  type CapturedElement,
  type CapturedPhoto,
} from "../_shared/browserless.ts";
import { BELOW_FOLD_PROBE, composeProbes, isBelowFoldReport } from "../_shared/below-fold-probe.ts";
import { afterImagesEnabled } from "../_shared/after-images-enabled.ts";
import { decryptString } from "../_shared/crypto.ts";
import { normalizeShopDomain, shopifyRest, exchangeClientCredentials } from "../_shared/shopify-api.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const STORAGE_BUCKET = "audit-assets";
const VIEWPORTS = ["desktop", "mobile"] as const;

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "authorization, x-client-info, apikey, content-type, accept, origin, referer, user-agent, x-cron-secret",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8", ...(init.headers ?? {}) },
    ...init,
  });
}

function assertServiceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Fire off another edge function without waiting for it to finish. The request
 * only has to be accepted; the short race keeps this invocation from being held
 * open by the next one's whole run. Mirrors chainAuto in web_generate_after. */
async function kick(fn: string, body: Record<string, unknown>) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    await Promise.race([
      fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: SUPABASE_SERVICE_ROLE_KEY,
        },
        body: JSON.stringify(body),
      }),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  } catch {
    // Best effort. A dropped link stalls the chain, which the workspace reports
    // as an interrupted run and a re-run resumes from the shots already taken.
  }
}

async function authorize(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (token && isServiceRoleAuthorization(token)) return;
  // The stall-recovery job (nudge_stalled_web_pipeline) reaches us on a schedule
  // with its own secret rather than a Supabase key, which cannot go stale the
  // way the vault's copy of the service role key did.
  if (await hasCronSecret(req, "web_pipeline_cron_secret")) return;
  // Every action (detect included) acts with the service role, so only staff
  // with audit access may drive it, not any signed-in session.
  await requireStaffUserId(req, "audits");
}

function normalizeUrl(raw: unknown): string | null {
  const url = String(raw ?? "").trim();
  if (!url) return null;
  const withProto = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    return new URL(withProto).toString();
  } catch {
    return null;
  }
}

function originOf(url: string): string {
  return new URL(url).origin;
}

// --- Page auto-detection -----------------------------------------------------

async function decryptShopifyToken(sb: ReturnType<typeof assertServiceClient>, clientId: string) {
  const [{ data: conn }, { data: sec }] = await Promise.all([
    sb.from("shopify_connections").select("shop_domain, auth_method, app_client_id").eq("client_id", clientId).maybeSingle(),
    sb.from("client_secrets").select("shopify_admin_token_ciphertext, shopify_admin_token_iv").eq("client_id", clientId).maybeSingle(),
  ]);
  const shopDomain = normalizeShopDomain(conn?.shop_domain ?? "");
  if (!shopDomain || !sec?.shopify_admin_token_ciphertext || !sec?.shopify_admin_token_iv) return null;
  try {
    const storedSecret = await decryptString(sec.shopify_admin_token_ciphertext, sec.shopify_admin_token_iv);
    if (conn?.auth_method === "client_credentials") {
      const grant = await exchangeClientCredentials(shopDomain, conn.app_client_id ?? "", storedSecret);
      if (!grant.ok) return null;
      return { shopDomain, token: grant.token };
    }
    return { shopDomain, token: storedSecret };
  } catch {
    return null;
  }
}

async function detectFromShopify(
  sb: ReturnType<typeof assertServiceClient>,
  clientId: string,
  origin: string,
): Promise<{ product?: string; collection?: string; variantId?: string }> {
  const creds = await decryptShopifyToken(sb, clientId);
  if (!creds) return {};
  const out: { product?: string; collection?: string; variantId?: string } = {};
  try {
    // Full product objects (not just handle) so we can also grab a variant id
    // for the add-to-cart permalink used by the cart capture.
    // Active is not enough: an active product can still be unpublished from the
    // online store, and its page would 404 for a shopper.
    const res = await shopifyRest(
      creds.shopDomain,
      creds.token,
      "/products.json?limit=5&status=active&published_status=published",
    );
    const prod = res.ok ? res.body?.products?.find((p: { handle?: string }) => p?.handle) : null;
    if (prod?.handle) out.product = `${origin}/products/${prod.handle}`;
    const variantId = prod?.variants?.find((v: { id?: number | string }) => v?.id)?.id;
    if (variantId) out.variantId = String(variantId);
  } catch { /* ignore */ }
  try {
    const [custom, smart] = await Promise.all([
      shopifyRest(creds.shopDomain, creds.token, "/custom_collections.json?limit=100&fields=handle,products_count"),
      shopifyRest(creds.shopDomain, creds.token, "/smart_collections.json?limit=100&fields=handle,products_count"),
    ]);
    const handle = pickCollectionHandle([
      ...(custom.ok ? custom.body?.custom_collections ?? [] : []),
      ...(smart.ok ? smart.body?.smart_collections ?? [] : []),
    ]);
    if (handle) out.collection = `${origin}/collections/${handle}`;
  } catch { /* ignore */ }
  return out;
}

/** Handles that are catch-alls or plainly internal rather than a real category a
 * shopper would browse. "all-excluded-products" got audited because the old
 * filter only excluded the exact handles "all" and "frontpage". */
const JUNK_COLLECTION_RE =
  /^(all|all-products|frontpage)$|excluded|hidden|internal|private|test|temp|archive|do-not|dont-|no-index|noindex|staff|sample/i;

/** Pick a real collection to audit, at random rather than always the first, so
 * repeat audits of one store show different pages. Collections with products win
 * over empty ones; an unknown count is treated as fine. */
function pickCollectionHandle(
  cols: Array<{ handle?: string; products_count?: number }>,
): string | null {
  const usable = cols
    .map((c) => ({ handle: (c.handle ?? "").trim(), count: c.products_count }))
    .filter((c) => c.handle && !JUNK_COLLECTION_RE.test(c.handle));
  if (usable.length === 0) return null;
  const withProducts = usable.filter((c) => c.count === undefined || (c.count ?? 0) > 0);
  const pool = withProducts.length > 0 ? withProducts : usable;
  return pool[Math.floor(Math.random() * pool.length)].handle;
}

// Public storefront JSON, available on virtually every Shopify store without an
// Admin connection. This is what unlocks a real product + a variant id (for the
// populated-cart permalink) and a real collection for un-connected clients.
async function detectFromStorefront(
  origin: string,
): Promise<{ product?: string; collection?: string; variantId?: string }> {
  const out: { product?: string; collection?: string; variantId?: string } = {};
  const headers = { "user-agent": "Mozilla/5.0 (compatible; ECDAuditBot/1.0)", accept: "application/json" };

  try {
    const res = await fetch(`${origin}/products.json?limit=50`, { headers, redirect: "follow" });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as {
        products?: Array<{
          handle?: string;
          images?: Array<unknown>;
          variants?: Array<{ id?: number | string; price?: string; available?: boolean }>;
        }>;
      } | null;
      const products = (body?.products ?? []).filter((p) => p?.handle && (p.variants ?? []).length > 0);
      // Prefer a flagship-looking product: has an image, an available variant, and
      // the highest price (avoids picking a cheap accessory like "adapter-pins").
      const priceOf = (p: { variants?: Array<{ price?: string }> }) =>
        Math.max(0, ...(p.variants ?? []).map((v) => parseFloat(v.price ?? "0") || 0));
      const withImage = products.filter((p) => (p.images ?? []).length > 0);
      const pool = withImage.length ? withImage : products;
      const chosen = pool.slice().sort((a, b) => priceOf(b) - priceOf(a))[0];
      if (chosen?.handle) {
        out.product = `${origin}/products/${chosen.handle}`;
        const variant = (chosen.variants ?? []).find((v) => v?.available !== false && v?.id) ??
          (chosen.variants ?? []).find((v) => v?.id);
        if (variant?.id) out.variantId = String(variant.id);
      }
    }
  } catch { /* ignore */ }

  try {
    const res = await fetch(`${origin}/collections.json?limit=50`, { headers, redirect: "follow" });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as {
        collections?: Array<{ handle?: string; products_count?: number }>;
      } | null;
      const handle = pickCollectionHandle(body?.collections ?? []);
      if (handle) out.collection = `${origin}/collections/${handle}`;
    }
  } catch { /* ignore */ }

  return out;
}

async function detectFromHtml(homepage: string, origin: string): Promise<{ product?: string; collection?: string }> {
  try {
    const res = await fetch(homepage, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; ECDAuditBot/1.0)" },
      redirect: "follow",
    });
    if (!res.ok) return {};
    const html = await res.text();
    const out: { product?: string; collection?: string } = {};
    const product = html.match(/\/products\/[a-z0-9][a-z0-9-]*/i)?.[0];
    const collection = html.match(/\/collections\/[a-z0-9][a-z0-9-]*/i)?.[0];
    // Skip the generic /collections/all when a more specific one might exist further down.
    if (product) out.product = `${origin}${product}`;
    if (collection) out.collection = `${origin}${collection}`;
    return out;
  } catch {
    return {};
  }
}

// --- Handlers ----------------------------------------------------------------

async function seed(
  sb: ReturnType<typeof assertServiceClient>,
  auditId: string,
  clientId: string,
  input: { homepage?: string; product?: string; collection?: string; cart?: string },
  reset = false,
) {
  const homepage = normalizeUrl(input.homepage);
  if (!homepage) return { error: "Invalid or missing homepage URL" };
  const origin = originOf(homepage);

  let product = normalizeUrl(input.product);
  let collection = normalizeUrl(input.collection);
  let variantId: string | undefined;

  // Stay on the pages this audit already looked at. Collection choice is random
  // per audit, so re-seeding to retry one failed shot used to silently swap the
  // whole collection page for a different one: the findings, their pin
  // coordinates and the "after" image all still described the previous page.
  // Whatever the caller passes explicitly still wins.
  if (!product || !collection) {
    const { data: prior } = await sb
      .from("web_page_snapshots")
      .select("page_type, url")
      .eq("audit_id", auditId)
      .in("page_type", ["product", "collection"]);
    for (const row of prior ?? []) {
      if (!product && row.page_type === "product") product = normalizeUrl(row.url);
      if (!collection && row.page_type === "collection") collection = normalizeUrl(row.url);
    }
  }

  // Detection precedence: manual input > Shopify Admin > public storefront JSON >
  // homepage HTML regex. Each source fills whatever the previous left unresolved.
  const viaShopify = await detectFromShopify(sb, clientId, origin);
  if (!product && viaShopify.product) product = normalizeUrl(viaShopify.product);
  if (!collection && viaShopify.collection) collection = normalizeUrl(viaShopify.collection);
  if (viaShopify.variantId) variantId = viaShopify.variantId;

  // Public storefront JSON works without a Shopify connection and, crucially,
  // yields a variant id to populate the cart.
  if (!product || !collection || !variantId) {
    const viaStore = await detectFromStorefront(origin);
    if (!product && viaStore.product) product = normalizeUrl(viaStore.product);
    if (!collection && viaStore.collection) collection = normalizeUrl(viaStore.collection);
    if (!variantId && viaStore.variantId) variantId = viaStore.variantId;
  }

  if (!product || !collection) {
    const viaHtml = await detectFromHtml(homepage, origin);
    product = product ?? (viaHtml.product ? normalizeUrl(viaHtml.product) : null);
    collection = collection ?? (viaHtml.collection ? normalizeUrl(viaHtml.collection) : null);
  }

  // Cart: captured as a POPULATED cart. At capture time we load the homepage, add
  // the flagship variant via Shopify's AJAX cart API, then click the cart trigger
  // (opens the slide drawer on drawer themes, or the /cart page otherwise). This
  // avoids the /cart/{variant}:1 permalink, which redirects to checkout on many
  // themes. The variant id is stashed on the cart rows below.
  const cart = normalizeUrl(input.cart) ?? homepage;

  const targets: Array<{ page_type: string; url: string }> = [{ page_type: "homepage", url: homepage }];
  if (product) targets.push({ page_type: "product", url: product });
  if (collection) targets.push({ page_type: "collection", url: collection });
  targets.push({ page_type: "cart", url: cart });

  // Only the 'viewport' (above-the-fold) shot per page/viewport. It's what the AI
  // vision analyzes AND what the report displays; the old heavy full-page 'full'
  // variant only fed an optional lightbox zoom and roughly doubled the load on
  // the screenshot service (the main cause of local_rate_limited). 8 rows total
  // when all pages resolve.
  const rows = targets.flatMap((t) =>
    VIEWPORTS.flatMap((viewport) => {
      const variants = ["viewport"];
      return variants.map((variant) => ({
        audit_id: auditId,
        client_id: clientId,
        page_type: t.page_type,
        viewport,
        variant,
        url: t.url,
        status: "pending",
        raw: t.page_type === "cart" && variantId ? { variant_id: variantId } : {},
      }));
    }),
  );

  // Resume rather than start over. The capture loop is driven from the browser,
  // so a refresh or a closed tab abandons a run part-way; re-running used to
  // delete every row and recapture all 8 pages, paying for work already done.
  // A shot is reusable only if it succeeded AND still points at the same URL,
  // so a re-detected product or collection page is always recaptured.
  let kept = 0;
  if (!reset) {
    const { data: existing } = await sb
      .from("web_page_snapshots")
      .select("id, page_type, viewport, variant, url, status")
      .eq("audit_id", auditId);
    const reusable = new Set(
      (existing ?? [])
        .filter((r) => r.status === "success")
        .filter((r) => rows.some((n) =>
          n.page_type === r.page_type && n.viewport === r.viewport && n.variant === r.variant && n.url === r.url
        ))
        .map((r) => `${r.page_type}|${r.viewport}|${r.variant}`),
    );
    kept = reusable.size;
    if (kept > 0) {
      const staleIds = (existing ?? [])
        .filter((r) => !(r.status === "success" && reusable.has(`${r.page_type}|${r.viewport}|${r.variant}`)))
        .map((r) => r.id);
      if (staleIds.length > 0) await sb.from("web_page_snapshots").delete().in("id", staleIds);
      const missing = rows.filter((n) => !reusable.has(`${n.page_type}|${n.viewport}|${n.variant}`));
      if (missing.length > 0) {
        const { error: insErr } = await sb.from("web_page_snapshots").insert(missing);
        if (insErr) throw insErr;
      }
      return {
        total: rows.length,
        reused: kept,
        resolved: {
          product: product ?? null,
          collection: collection ?? null,
          detected: { product: Boolean(product), collection: Boolean(collection) },
        },
      };
    }
  }

  // Rebuild the row set WITHOUT changing ids. Findings pin their highlights to a
  // snapshot_id, so deleting and reinserting orphaned every pin on the report:
  // the coordinates survived, the anchor did not, and the "before" screenshots
  // came back bare. Reset the existing rows in place, add only what is genuinely
  // new, and drop only what is no longer targeted.
  const { data: current } = await sb
    .from("web_page_snapshots")
    .select("id, page_type, viewport, variant")
    .eq("audit_id", auditId);
  const keyOf = (r: { page_type: string; viewport: string; variant: string }) =>
    `${r.page_type}|${r.viewport}|${r.variant}`;
  const existingByKey = new Map((current ?? []).map((r) => [keyOf(r), r.id]));

  const toInsert = rows.filter((r) => !existingByKey.has(keyOf(r)));
  for (const row of rows) {
    const id = existingByKey.get(keyOf(row));
    if (!id) continue;
    const { error: updErr } = await sb
      .from("web_page_snapshots")
      .update({
        url: row.url,
        status: "pending",
        raw: row.raw,
        screenshot_url: null,
        screenshot_path: null,
        elements: null,
        error_message: null,
        // fetched_at is NOT NULL in the live table, so "start again" is now (a null
        // made every re-capture of an existing audit fail). The stall nudge reads the
        // newest fetched_at, so a fresh run also gets its full grace period.
        fetched_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (updErr) throw updErr;
  }
  if (toInsert.length > 0) {
    const { error: insErr } = await sb.from("web_page_snapshots").insert(toInsert);
    if (insErr) throw insErr;
  }
  const wantedKeys = new Set(rows.map(keyOf));
  const removeIds = (current ?? []).filter((r) => !wantedKeys.has(keyOf(r))).map((r) => r.id);
  if (removeIds.length > 0) await sb.from("web_page_snapshots").delete().in("id", removeIds);

  return {
    total: rows.length,
    reused: 0,
    resolved: {
      product: product ?? null,
      collection: collection ?? null,
      detected: { product: Boolean(product), collection: Boolean(collection) },
    },
  };
}

/** Hard ceiling on capture passes for one row, counted when a pass STARTS. The
 * per-cause budgets below normally end a row well before this; the ceiling is
 * for passes that never got to write anything (killed at the wall clock), which
 * used to retry every five minutes for a whole day. */
const MAX_CAPTURE_PASSES = 8;
/** A claim older than this belongs to a dead invocation (the edge wall clock is
 * 150s), so another chain may take the row. */
const CLAIM_STALE_MS = 3 * 60 * 1000;

async function captureOne(
  sb: ReturnType<typeof assertServiceClient>,
  auditId: string,
  clientId: string,
): Promise<{ processed: number; remaining: number; requeued?: boolean; busy?: boolean }> {
  const countRemaining = async () => {
    const { count } = await sb
      .from("web_page_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("audit_id", auditId)
      .eq("status", "pending");
    return count ?? 0;
  };

  // Only rows nobody is working on: unclaimed, or claimed by a dead invocation.
  const staleIso = new Date(Date.now() - CLAIM_STALE_MS).toISOString();
  const claimable = `raw->>claimed_at.is.null,raw->>claimed_at.lt."${staleIso}"`;

  // Prefer rows we haven't touched yet over ones we requeued after a
  // rate-limit, so a stuck store doesn't block the others.
  const { data: candidate, error: rowErr } = await sb
    .from("web_page_snapshots")
    .select("id, page_type, viewport, variant, url, raw")
    .eq("audit_id", auditId)
    .eq("status", "pending")
    .or(claimable)
    .order("fetched_at", { ascending: true, nullsFirst: true })
    .order("page_type", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (rowErr) throw rowErr;

  if (!candidate) {
    const remaining = await countRemaining();
    // Rows still pending but all claimed: another chain is on them.
    return { processed: 0, remaining, busy: remaining > 0 };
  }

  const raw0 = ((candidate as { raw?: Record<string, unknown> }).raw ?? {}) as Record<string, unknown>;
  const passes = Number(raw0.pass_attempts ?? 0);
  if (passes >= MAX_CAPTURE_PASSES) {
    const last = String(raw0.capture_note ?? "").slice(0, 300);
    await sb.from("web_page_snapshots").update({
      status: "error",
      error_message: `capture_gave_up: ${passes} passes without a usable shot${last ? `; last: ${last}` : ""}`.slice(0, 500),
      fetched_at: new Date().toISOString(),
    }).eq("id", candidate.id).eq("status", "pending");
    return { processed: 1, remaining: await countRemaining() };
  }

  // Claim the row atomically. Postgres re-checks the WHERE after taking the row
  // lock, so of two chains reaching for the same row only one gets it back.
  // The pass is counted HERE, before the capture, so a pass the runtime kills
  // still counts. fetched_at is stamped so the stall nudge sees a live chain.
  const claimedAt = new Date().toISOString();
  const { data: claimed, error: claimErr } = await sb
    .from("web_page_snapshots")
    .update({
      raw: { ...raw0, pass_attempts: passes + 1, claimed_at: claimedAt },
      fetched_at: claimedAt,
    })
    .eq("id", candidate.id)
    .eq("status", "pending")
    .or(claimable)
    .select("id");
  if (claimErr) throw claimErr;
  if (!Array.isArray(claimed) || claimed.length === 0) {
    return { processed: 0, remaining: await countRemaining(), busy: true };
  }
  // Every later write spreads this raw, which has no claimed_at, so a requeue
  // releases the claim for this chain's next pass.
  const row = { ...candidate, raw: { ...raw0, pass_attempts: passes + 1 } };

  // Only click the slide-drawer when the cart capture targets a non-/cart page
  // (the homepage fallback). A /cart permalink already lands on a populated
  // cart page, so we screenshot it directly.
  let interaction: "cart_drawer" | undefined;
  if (row.page_type === "cart") {
    let path = "";
    try { path = new URL(row.url).pathname; } catch { /* ignore */ }
    if (!/^\/cart(\/|$)/.test(path)) interaction = "cart_drawer";
  }

  const isViewport = (row as { variant?: string }).variant === "viewport";
  let png: Uint8Array | null = null;
  // Optional next-viewport-down shot, kept only as context for the "after" image
  // generator so it knows what really continues below the crop.
  let pngFold2: Uint8Array | null = null;
  let elements: CapturedElement[] = [];
  // Complete photo inventory for this shot, stored so the after-image compositor
  // can restore the client's own photos rather than trusting the model to
  // reproduce them. Browserless-only: the ScreenshotOne fallback cannot probe.
  let photos: CapturedPhoto[] = [];
  let captureError = "";
  let browserlessError = ""; // kept separate so the fallback's error doesn't hide it
  let usedBrowserless = false;
  // Which proxy pool this pass went through (recorded for cost verification).
  let proxyTierUsed: "datacenter" | "residential" | null = null;
  // What Browserless was actually told to use. This differs from proxyTierUsed
  // when BROWSERLESS_PROXY pins a single pool instead of being set to "auto",
  // which is the difference between the tiering saving money and only looking
  // like it does.
  let proxyUsed: string | null = null;
  let belowFold: unknown = null;
  // Null while the capture has not looked, [] when it looked and saw none. The
  // difference decides whether the audit may talk about popups at all.
  let popups: unknown[] | null = null;
  // How long the capture waited for placeholder cards to become real products,
  // when the page had any. Kept so a thin-looking shot can be explained.
  let contentWait: unknown = null;
  // Where the slide-cart drawer settled, for the same reason.
  let cartDrawerInfo: unknown = null;
  let cartCount: number | null = null;

  // When Browserless is configured it handles every capture (full-page and
  // viewport): ad + cookie-banner blocking are built in, the cart drawer is a
  // scripted click, and the viewport shot also returns real element boxes so
  // findings pin an actual element instead of a guessed coordinate. ScreenshotOne
  // remains the fallback below if Browserless is unset or a call fails.
  const isCart = row.page_type === "cart";
  // Pages with a product grid: whether a quick-add exists behind :hover is a
  // real finding either way, and it cannot be read off a screenshot.
  const hasProductGrid = row.page_type === "collection" || row.page_type === "homepage";
  let hoverProbe: { hovered: boolean; target?: string; revealed: string[]; quickAdd: boolean } | null = null;
  let cartAdd: { variantId: string | null; productUrl: string | null; pageOnly?: boolean } | undefined = undefined;
  if (isCart) {
    // Pass the detected product page so the capture can read a real variant off it
    // when we have no variant id, and reliably add via the cart permalink.
    const { data: prod } = await sb
      .from("web_page_snapshots")
      .select("url")
      .eq("audit_id", auditId)
      .eq("page_type", "product")
      .limit(1)
      .maybeSingle();
    // Once the drawer route has failed a couple of times, stop repeating it. Its
    // click storm (a dozen triggers, each re-navigating on a miss) is what makes
    // bot-protected storefronts start demanding verification, so the retry asks
    // for the lean route instead: cart permalink, then screenshot /cart. Proven
    // against Power Planter, whose drawer route failed eleven times in a row
    // while permalink-then-/cart populated the cart in about five seconds.
    const rawNow = ((row as { raw?: Record<string, unknown> }).raw ?? {}) as Record<string, unknown>;
    const cartTries = Number(rawNow.bl_attempts ?? 0) + Number(rawNow.cart_attempts ?? 0);
    cartAdd = {
      variantId: (row as { raw?: { variant_id?: string } }).raw?.variant_id ?? null,
      productUrl: (prod?.url as string | undefined) ?? null,
      pageOnly: cartTries >= 2,
    };
  }
  if (browserlessEnabled()) {
    // Proxy tiering (BROWSERLESS_PROXY=auto): first try the cheap datacenter
    // pool, and fall back to residential on any retry pass, since the usual
    // reason a pass failed is the storefront disliking the traffic. Carts are
    // always residential: the add-to-cart flow is the most bot-sensitive thing
    // we do and already the flakiest.
    const rawForTier = ((row as { raw?: Record<string, unknown> }).raw ?? {}) as Record<string, unknown>;
    const isRetryPass =
      Number(rawForTier.bl_attempts ?? 0) > 0 ||
      Number(rawForTier.capture_attempts ?? 0) > 0 ||
      Number(rawForTier.cart_attempts ?? 0) > 0;
    const proxyTier: "datacenter" | "residential" = isCart || isRetryPass ? "residential" : "datacenter";
    proxyTierUsed = proxyTier;
    const blInput = {
      url: row.url,
      viewport: row.viewport as "desktop" | "mobile",
      // The cart drawer is a viewport overlay, so never full-page for cart.
      fullPage: !isViewport && !isCart,
      withElements: isViewport,
      // Desktop only. A headless mouse triggers :hover at any viewport size, but
      // a phone shopper cannot hover at all, so probing the mobile shot would
      // report a control no real visitor can reach as if it were available.
      hoverProbe: isViewport && hasProductGrid && !isCart && row.viewport === "desktop",
      // The second-fold shot is context for the after-image generator and
      // nothing else reads fold2_url, so it is pure waste while afters are off:
      // one extra screenshot per viewport page, six per audit.
      secondFold: afterImagesEnabled() && isViewport && !isCart,
      cartAdd,
      proxyTier,
      // The cart flow chains up to five navigations; 90s aborted it mid-flow on
      // slower stores even over a healthy residential connection. 120s leaves
      // room under the 150s edge wall clock to record the outcome, so a slow
      // cart ends as a counted miss instead of a silent kill.
      timeoutMs: isCart ? 120_000 : undefined,
      // A read-only probe of the settled page, in the SAME load as the
      // screenshot. The below-fold report is what the screenshot cannot show:
      // the crop stops at the first screen, so without it the audit was guessing
      // about reviews, cross-sells, the FAQ and the footer. The DOM outline that
      // used to share this slot fed only the retired HTML after engine, so it no
      // longer runs; an empty first probe keeps the { below_fold } result shape.
      probeScript: isViewport ? composeProbes("return null;", BELOW_FOLD_PROBE) : undefined,
    };
    // One attempt per invocation — retries happen across requeue passes below,
    // so a single capture_one never risks the edge runtime's wall-clock limit.
    const bl = await captureWithBrowserless(blInput);
    proxyUsed = bl.proxyUsed ?? null;
    if (bl.ok) {
      png = bl.png;
      pngFold2 = bl.png2 ?? null;
      elements = bl.elements;
      photos = bl.photos ?? [];
      hoverProbe = bl.hover ?? null;
      const bf = (bl.probe as { below_fold?: unknown } | null)?.below_fold;
      if (isBelowFoldReport(bf)) belowFold = bf;
      popups = Array.isArray(bl.popups) ? bl.popups : [];
      contentWait = bl.contentWait ?? null;
      cartDrawerInfo = bl.cartDrawer ?? null;
      usedBrowserless = true;
      if (typeof bl.cartCount === "number") cartCount = bl.cartCount;
    } else {
      browserlessError = bl.error; // remember it
      captureError = bl.error;
    }
  }

  // Browserless is the reliable primary; ScreenshotOne's plan rate-limits under
  // load. So if Browserless failed, retry IT across a few requeue passes before
  // ever touching ScreenshotOne, most misses are transient and a later pass
  // succeeds on Browserless (no rate-limit, no fallback).
  // A quota/auth failure (out of Browserless units, bad token) won't fix itself
  // on retry, so don't waste passes, fall straight to the ScreenshotOne fallback.
  const failKind = !png && browserlessError ? classifyCaptureFailure(browserlessError) : null;
  // A page that does not exist, or a store behind its password page, will look
  // the same on every pass, and the fallback would only photograph the error
  // page and call it a success. End the row here.
  if (failKind === "page_missing" || failKind === "store_password_protected") {
    await sb.from("web_page_snapshots").update({
      status: "error",
      error_message: browserlessError.slice(0, 500),
      fetched_at: new Date().toISOString(),
    }).eq("id", row.id);
    return { processed: 1, remaining: await countRemaining() };
  }
  const blHopeless = failKind === "hopeless";
  if (!png && browserlessEnabled() && !blHopeless) {
    const rawObj = ((row as { raw?: Record<string, unknown> }).raw ?? {}) as Record<string, unknown>;
    const blAttempts = Number(rawObj.bl_attempts ?? 0);
    // Storefront rate-limits / bot-challenges clear on a later pass (and a fresh
    // residential IP), so give them more passes than a plain transient miss. A
    // plain server error is a transient miss, not a block.
    const blBudget = failKind === "blocked" ? 6 : 3;
    if (blAttempts < blBudget) {
      await sb.from("web_page_snapshots").update({
        raw: { ...rawObj, bl_attempts: blAttempts + 1, capture_note: `browserless_retry_${blAttempts + 1}: ${browserlessError}`.slice(0, 300) },
        error_message: null,
        fetched_at: new Date().toISOString(),
      }).eq("id", row.id);
      return { processed: 0, requeued: true, remaining: await countRemaining() };
    }
  }

  // ScreenshotOne, only after Browserless has been retried and still failed.
  // NEVER for the cart: ScreenshotOne cannot add a product or open a drawer, so
  // it returns whatever the cart URL renders, which is the homepage with an empty
  // cart. That is how a client report grew a "Cart" section describing the home
  // page. A failed cart capture must stay failed, so the section hides instead.
  if (!png && isCart && browserlessEnabled()) {
    await sb.from("web_page_snapshots").update({
      status: "error",
      error_message: `cart_capture_failed: ${(browserlessError || captureError || "unknown").slice(0, 300)}`,
      fetched_at: new Date().toISOString(),
    }).eq("id", row.id);
    return { processed: 1, remaining: await countRemaining() };
  }
  if (!png) {
    // An unconfigured fallback throws. Uncaught, that ended the chain with the
    // row still pending, and the stall nudge retried it every five minutes.
    let provider: ReturnType<typeof getScreenshotProvider>;
    try {
      provider = getScreenshotProvider();
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await sb.from("web_page_snapshots").update({
        status: "error",
        error_message: `capture_failed: no fallback provider (${why})${browserlessError ? ` | browserless: ${browserlessError}` : ""}`
          .slice(0, 500),
        fetched_at: new Date().toISOString(),
      }).eq("id", row.id);
      return { processed: 1, remaining: await countRemaining() };
    }
    const captureInput = {
      url: row.url,
      viewport: row.viewport as "desktop" | "mobile",
      interaction,
      fullPage: !isViewport,
    };
    // Single attempt; a rate-limit or transient failure is requeued below and
    // retried on a later pass, keeping each invocation short.
    const result = await provider.capture(captureInput);
    if (result.ok) {
      png = result.png;
      elements = [];
    } else {
      captureError = result.error;
    }
  }

  // Never store an empty cart. The whole point of the cart shot is a filled
  // slide-drawer; a count of 0 (or -1 = the add/cart.js call itself failed) means
  // the add did not stick on this pass, usually a flaky residential IP or a
  // storefront that rate-limited the /cart/add.js XHR. Requeue and retry: a later
  // pass gets a fresh IP and the add typically succeeds (as it reliably does on
  // mobile). Bounded so a store with no addable product can't loop forever.
  if (png && isCart && usedBrowserless && (cartCount === null || cartCount <= 0)) {
    const rawObj = ((row as { raw?: Record<string, unknown> }).raw ?? {}) as Record<string, unknown>;
    const cartAttempts = Number(rawObj.cart_attempts ?? 0) + 1;
    if (cartAttempts < 5) {
      await sb.from("web_page_snapshots").update({
        raw: { ...rawObj, cart_attempts: cartAttempts, capture_note: `empty_cart_retry_${cartAttempts} (count ${cartCount})` },
        error_message: null,
        fetched_at: new Date().toISOString(),
      }).eq("id", row.id);
      return { processed: 0, requeued: true, remaining: await countRemaining() };
    }
    // Budget exhausted: store what we have rather than block the audit forever.
  }

  const now = new Date().toISOString();

  if (png) {
    const variantSuffix = isViewport ? "_viewport" : "";
    const path = `${clientId}/${auditId}/web/${row.page_type}_${row.viewport}${variantSuffix}.png`;
    const { error: uploadErr } = await sb.storage
      .from(STORAGE_BUCKET)
      .upload(path, png, { contentType: "image/png", upsert: true });
    if (uploadErr) {
      await sb.from("web_page_snapshots").update({
        status: "error",
        error_message: `upload_failed: ${uploadErr.message}`.slice(0, 500),
        fetched_at: now,
      }).eq("id", row.id);
    } else {
      const { data: pub } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(path);
      // A re-capture overwrites the SAME storage path, so without this the URL
      // never changes and nothing downstream knows the picture did. Supabase
      // serves these with max-age=3600, so a strategist who had the report open
      // kept seeing the old shot for an hour and reported the fix as not having
      // worked. A version stamp gives every capture its own URL, which no cache
      // can answer from a previous one.
      const versionedUrl = pub?.publicUrl ? `${pub.publicUrl}?v=${Date.parse(now)}` : null;

      // Store the next-fold shot alongside it and remember its URL on the row.
      // It is deliberately NOT a web_page_snapshots row of its own: it must never
      // appear in the report or be analyzed for findings, it is only context for
      // the "after" image generator.
      let fold2Url: string | null = null;
      if (pngFold2) {
        const fold2Path = `${clientId}/${auditId}/web/${row.page_type}_${row.viewport}_fold2.png`;
        const { error: f2Err } = await sb.storage
          .from(STORAGE_BUCKET)
          .upload(fold2Path, pngFold2, { contentType: "image/png", upsert: true });
        if (!f2Err) {
          const f2Public = sb.storage.from(STORAGE_BUCKET).getPublicUrl(fold2Path).data?.publicUrl ?? null;
          // Versioned for the same reason as the main shot: this path is
          // overwritten on a re-capture, and the after generator fetching a
          // cached previous fold would describe content that is no longer there.
          fold2Url = f2Public ? `${f2Public}?v=${Date.parse(now)}` : null;
        }
      }

      // If Browserless failed and we recovered via ScreenshotOne, keep a
      // diagnostic note (the capture still succeeded) so we can see which
      // provider handled it and why Browserless fell back.
      const rawObj = ((row as { raw?: Record<string, unknown> }).raw ?? {}) as Record<string, unknown>;
      const baseRaw = usedBrowserless
        ? rawObj
        : { ...rawObj, capture_note: `via_screenshotone${browserlessError ? `; browserless: ${browserlessError}` : ""}`.slice(0, 300) };
      // Record the cart item count on cart captures so we can confirm the cart
      // was actually filled (not an empty slide-cart).
      const withCart = row.page_type === "cart" && cartCount !== null
        ? { ...baseRaw, cart_count: cartCount }
        : baseRaw;
      const withFold = fold2Url ? { ...withCart, fold2_url: fold2Url } : withCart;
      // What the crop cut off, so the analysis can stop guessing about it.
      const withBelow = belowFold ? { ...withFold, below_fold: belowFold } : withFold;
      // And what the sweep removed. Recorded even when empty: "looked, saw
      // none" and "never looked" lead to different sentences in the report.
      const withPopups = popups ? { ...withBelow, popups, popups_observed: true } : withBelow;
      // How long we waited for placeholder cards to become real products, when
      // the page had any, so a thin-looking shot can be explained afterwards.
      const withWait = contentWait ? { ...withPopups, content_wait: contentWait } : withPopups;
      const withDrawer = cartDrawerInfo ? { ...withWait, cart_drawer: cartDrawerInfo } : withWait;
      // Every photo painted in this shot (the analysis reads it too).
      const withPhotos = photos.length ? { ...withDrawer, photos } : withDrawer;
      // Which proxy pool served this capture, so the datacenter-vs-residential
      // savings are verifiable from the rows rather than guessed.
      const withHover = hoverProbe ? { ...withPhotos, hover: hoverProbe } : withPhotos;
      const raw = proxyTierUsed && usedBrowserless
        ? { ...withHover, proxy_tier: proxyTierUsed, proxy_used: proxyUsed ?? "none" }
        : withHover;
      await sb.from("web_page_snapshots").update({
        status: "success",
        screenshot_path: path,
        screenshot_url: versionedUrl,
        elements,
        error_message: null,
        raw,
        fetched_at: now,
      }).eq("id", row.id);
    }
  } else {
    // A ScreenshotOne "local_rate_limited" (plan concurrency) or store bot-block
    // is transient: requeue the row (keep it pending, deprioritized) so the
    // orchestrator retries it later once the limit clears. Bounded so a
    // genuinely broken page eventually errors out instead of looping forever.
    const rawObj = ((row as { raw?: Record<string, unknown> }).raw ?? {}) as Record<string, unknown>;
    const attempts = Number(rawObj.capture_attempts ?? 0) + 1;
    const rateLimited = /rate_limited|rate.?limit|429|too_many/i.test(captureError);
    const blSuffix = browserlessError ? ` | browserless: ${browserlessError}` : "";
    if (rateLimited && attempts < 5) {
      await sb.from("web_page_snapshots").update({
        raw: { ...rawObj, capture_attempts: attempts },
        error_message: `${captureError} (rate-limited; requeued, attempt ${attempts})${blSuffix}`.slice(0, 500),
        fetched_at: now,
      }).eq("id", row.id);
      return { processed: 0, requeued: true, remaining: await countRemaining() };
    }
    await sb.from("web_page_snapshots").update({
      status: "error",
      error_message: `${captureError || "capture_failed"}${blSuffix}`.slice(0, 500),
      fetched_at: now,
    }).eq("id", row.id);
  }

  return { processed: 1, remaining: await countRemaining() };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: { code: "method_not_allowed" } }, { status: 405 });

  const correlationId = crypto.randomUUID();
  try {
    await authorize(req);

    const input = (await req.json()) as {
      action?: "seed" | "capture_one" | "run" | "detect";
      /** detect only: the homepage to resolve pages for, before an audit exists. */
      website_url?: string;
      audit_id?: string;
      client_id?: string;
      pages?: { homepage?: string; product?: string; collection?: string; cart?: string };
      /** Force a full recapture instead of reusing screenshots that succeeded. */
      reset?: boolean;
      /** Chain depth, set only by the function re-invoking itself. */
      depth?: number;
    };
    const auditId = (input.audit_id ?? "").trim();
    const clientId = (input.client_id ?? "").trim();
    const action = input.action ?? "seed";

    // Which pages WOULD this audit capture? Asked from the new-audit form so the
    // strategist can see and change them before anything runs, rather than
    // finding out from the finished report. Same resolution order as seed, but
    // it writes nothing and needs no audit to exist yet.
    //
    // The answer is then submitted as explicit page overrides, which also pins
    // the collection: seed picks one at random, so without pinning the report
    // could cover a different collection than the one previewed here.
    if (action === "detect") {
      const homepage = normalizeUrl(input.website_url);
      if (!homepage) {
        return json({ ok: false, error: { code: "bad_request", message: "Missing website_url" }, correlationId }, { status: 400 });
      }
      const origin = originOf(homepage);
      const sb = assertServiceClient();
      let product: string | null = null;
      let collection: string | null = null;
      const sources: string[] = [];

      if (clientId) {
        const viaShopify = await detectFromShopify(sb, clientId, origin).catch(() => ({}) as Record<string, string>);
        if (viaShopify.product) { product = normalizeUrl(viaShopify.product); sources.push("shopify_admin"); }
        if (viaShopify.collection) collection = normalizeUrl(viaShopify.collection);
      }
      if (!product || !collection) {
        const viaStore = await detectFromStorefront(origin).catch(() => ({}) as Record<string, string>);
        if (!product && viaStore.product) { product = normalizeUrl(viaStore.product); sources.push("storefront_json"); }
        if (!collection && viaStore.collection) { collection = normalizeUrl(viaStore.collection); sources.push("storefront_json"); }
      }
      if (!product || !collection) {
        const viaHtml = await detectFromHtml(homepage, origin).catch(() => ({}) as Record<string, string>);
        if (!product && viaHtml.product) { product = normalizeUrl(viaHtml.product); sources.push("homepage_html"); }
        if (!collection && viaHtml.collection) { collection = normalizeUrl(viaHtml.collection); sources.push("homepage_html"); }
      }

      return json({
        ok: true,
        correlationId,
        homepage,
        product,
        collection,
        // The cart is never a URL we pick: capture adds the flagship variant and
        // opens whatever the theme shows, so there is nothing to prefill.
        cart: null,
        sources: [...new Set(sources)],
      });
    }

    if (!auditId || !clientId) {
      return json({ ok: false, error: { code: "bad_request", message: "Missing audit_id or client_id" }, correlationId }, { status: 400 });
    }

    const sb = assertServiceClient();

    if (action === "seed") {
      const result = await seed(sb, auditId, clientId, input.pages ?? {}, input.reset === true);
      if ("error" in result) {
        return json({ ok: false, error: { code: "bad_request", message: result.error }, correlationId }, { status: 400 });
      }
      // Start the capture chain HERE, not from the browser. The client used to
      // send seed and then a second "run" call, and closing the tab in that gap
      // left the rows seeded with no chain running: 0 of 8, forever. Once the
      // seed request reaches the server, the run no longer needs the tab at all.
      await kick("web_capture_screenshots", { action: "run", audit_id: auditId, client_id: clientId });
      return json({ ok: true, correlationId, ...result }, { status: 200 });
    }

    // capture_one, or "run": the same single capture, but the server carries the
    // sequence forward itself instead of relying on the browser to ask again.
    // That is what makes closing the tab safe.
    const { processed, remaining, busy } = await captureOne(sb, auditId, clientId);
    if (action === "run") {
      // Per-row attempt budgets already bound the work (a row ends as success or
      // error), so this is a backstop against a bug in those budgets rather than
      // the primary limit: 8 rows at ~6 passes each is well under the cap.
      const depth = Number(input.depth ?? 0);
      if (busy) {
        // Every pending row is claimed by another live chain. That chain carries
        // the run to the end (and kicks analysis), so this one stops rather than
        // running a second chain alongside it. If it dies, its claims go stale
        // and the stall nudge restarts the run.
      } else if (remaining > 0 && depth < 80) {
        await kick("web_capture_screenshots", {
          action: "run",
          audit_id: auditId,
          client_id: clientId,
          depth: depth + 1,
        });
      } else if (remaining > 0) {
        console.error(`capture chain hit the depth cap for audit ${auditId} with ${remaining} pending`);
      } else {
        // Capture finished: hand off to analysis so the whole pipeline runs
        // server-side. web_finalize_analysis self-chains through its own steps.
        await kick("web_finalize_analysis", { audit_id: auditId });
      }
    }
    return json({ ok: true, correlationId, processed, remaining, done: remaining === 0 }, { status: 200 });
  } catch (e) {
    return json(
      { ok: false, error: { code: "request_failed", message: e instanceof Error ? e.message : "Unknown error" }, correlationId },
      { status: 200 },
    );
  }
});
