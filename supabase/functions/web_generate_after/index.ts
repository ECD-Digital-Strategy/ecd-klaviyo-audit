import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hasCronSecret, isServiceRoleAuthorization, requireStaffUserId } from "../_shared/auth.ts";
import { getSecret } from "../_shared/app-secrets.ts";
import { type WebPageKind } from "../_shared/ecommerce-ux-kb.ts";
// The prompt, the Gemini call, and the vision QA live in _shared so the model
// bake-off script exercises candidate models with the EXACT production pieces.
import {
  buildEditPrompt,
  geminiEditImage,
  photoShapeNote,
  pngSize,
  wrongShape,
  type CapturedEl,
  type Viewport,
} from "../_shared/after-image-prompt.ts";
import {
  isCriticalLayoutDefect,
  isPhotoDefect,
  verifyCheckoutVisible,
  verifyTextIntegrity,
  verifyAfterImage,
  verifyPhotoFidelity,
  verifyScore,
} from "../_shared/after-image-verify.ts";
import { autoPublishAudit } from "../_shared/auto-publish.ts";
import { afterImagesEnabled } from "../_shared/after-images-enabled.ts";
import { isUsableOutline, runHtmlAfter, summarizeEditReport } from "../_shared/html-after.ts";
import { conformToSize, cropToSupportedRatio, lockSlotsPrompt, maskPhotos, prepareLockBoxes, restorePhotos, type PhotoBox } from "../_shared/after-composite.ts";

// Generates an "after" concept image for a web-audit page section.
//
// TWO ENGINES, in order:
//  1. HTML (default). Loads the REAL page in a browser, applies the fixes as
//     DOM/CSS edits, and re-screenshots it. Nothing is regenerated, so the
//     client's photographs, fonts, colours and logo are physically incapable of
//     being cropped, reshaped, substituted or drifting off brand. Fix coverage
//     and photo integrity are both measured in code, not judged from a picture.
//  2. Gemini image edit (fallback). Used only when the HTML pass cannot run:
//     a store that blocks the browser, an unusable DOM outline, or selectors the
//     author could not resolve. Keeps its hard photo gate, so it still withholds
//     an image whose photos came back damaged.
//
// Which engine produced each image is recorded per viewport, so a result is
// always attributable rather than assumed.
//
// Two modes:
//  - Single: { audit_id, section_key, viewport? } generates one image and returns
//    its URL. Used by the on-demand "Regenerate" button in the report editor.
//  - Auto:   { audit_id, mode:"auto" } finds the next page section without an
//    after image and generates one, then self-chains for the rest. Fired
//    (best effort) at the end of web_finalize_analysis.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GEMINI_IMAGE_MODEL = Deno.env.get("GEMINI_IMAGE_MODEL") ?? "gemini-3.1-flash-image";
// The pro image tier ("Nano Banana Pro"): measurably better long-text rendering
// and layout control, which is exactly what a storefront screenshot is. Tried
// first; the runtime falls back to the flash model above if the account cannot
// use it (wrong id, no access, quota).
const GEMINI_IMAGE_MODEL_PRO = Deno.env.get("GEMINI_IMAGE_MODEL_PRO") ?? "gemini-3-pro-image-preview";
const STORAGE_BUCKET = "audit-assets";

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

// Page sections that get an "after" (screenshot-backed). Analytics/overview/
// roadmap have no page shot, so they are excluded.
const PAGE_SECTIONS: Array<{ key: string; page_type: string; label: string }> = [
  { key: "web_homepage", page_type: "homepage", label: "homepage" },
  { key: "web_product_page", page_type: "product", label: "product page" },
  { key: "web_collection_page", page_type: "collection", label: "collection page" },
  { key: "web_cart", page_type: "cart", label: "cart / slide-out cart drawer" },
];

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

type ViewportSource = {
  viewport: Viewport;
  /** Public URL of the stored "before" screenshot. */
  url: string;
  cartCount: number;
  fold2Url?: string | null;
  elements?: CapturedEl[];
  /** The storefront page itself, so the HTML engine can reopen and edit it. */
  pageUrl?: string | null;
  /** DOM outline captured in the same page load as the screenshot, when present. */
  outline?: unknown;
  /** Cart captures need the variant re-added before the drawer has anything in it. */
  variantId?: string | null;
  /** Complete capture-time photo inventory (raw.photos); drives the compositor. */
  photos?: PhotoBox[];
  /** Must-not-change text (raw.text_locks): titles, prices, ratings, brand. */
  textLocks?: PhotoBox[];
};

// One source screenshot per viewport for a page (above-the-fold variant preferred).
async function listViewportSources(sb: SupabaseClient, auditId: string, pageType: string): Promise<ViewportSource[]> {
  const { data } = await sb
    .from("web_page_snapshots")
    .select("viewport, variant, status, url, screenshot_url, raw, elements")
    .eq("audit_id", auditId)
    .eq("page_type", pageType)
    .eq("status", "success")
    .not("screenshot_url", "is", null);
  const rows = (data ?? []) as Array<{
    viewport: string;
    variant: string | null;
    url: string | null;
    screenshot_url: string;
    raw: Record<string, unknown> | null;
    elements: CapturedEl[] | null;
  }>;
  const out: ViewportSource[] = [];
  for (const vp of ["desktop", "mobile"] as Viewport[]) {
    const vpRows = rows.filter((r) => r.viewport === vp);
    if (vpRows.length === 0) continue;
    const chosen = vpRows.find((r) => r.variant === "viewport") ?? vpRows[0];
    const cartCount = Math.max(...vpRows.map((r) => Number(r.raw?.cart_count ?? -1)), -1);
    const f2 = chosen.raw?.fold2_url;
    out.push({
      viewport: vp,
      url: chosen.screenshot_url,
      cartCount,
      fold2Url: typeof f2 === "string" && f2.length > 0 ? f2 : null,
      elements: Array.isArray(chosen.elements) ? chosen.elements : [],
      pageUrl: chosen.url ?? null,
      outline: chosen.raw?.dom_outline ?? null,
      variantId: typeof chosen.raw?.variant_id === "string" ? chosen.raw.variant_id : null,
      photos: Array.isArray(chosen.raw?.photos) ? (chosen.raw.photos as PhotoBox[]) : [],
      textLocks: Array.isArray(chosen.raw?.text_locks) ? (chosen.raw.text_locks as PhotoBox[]) : [],
    });
  }
  return out;
}

// Which viewports to generate for a page, in order [primary, ...rest]. The
// primary is the source of truth the other viewport mirrors. Desktop is primary
// when available; for the cart, only viewports whose slide-cart actually filled
// are eligible (an "after" of an empty cart is pointless), with the filled one
// as primary.
function orderedViewports(sources: ViewportSource[], pageType: string, preferred?: Viewport): Viewport[] {
  let eligible = sources;
  if (pageType === "cart") {
    const filled = sources.filter((s) => s.cartCount > 0);
    if (filled.length > 0) eligible = filled;
  }
  const vps = eligible.map((s) => s.viewport);
  if (vps.length === 0) return [];
  let primary: Viewport | undefined = preferred && vps.includes(preferred) ? preferred : undefined;
  if (!primary) primary = vps.includes("desktop") ? "desktop" : vps[0];
  return [primary, ...vps.filter((v) => v !== primary)];
}

// Fixes about repositioning floating widgets (chat bubble, rewards/loyalty
// badge, back-to-top). The image model cannot do this edit: instead of moving the
// widget it draws a second copy and leaves the original overlapping, which is
// worse than not attempting it. We keep these OUT of the image prompt and replace
// them with a hard "reproduce the floating icons exactly once, unchanged"
// constraint. The finding still states the fix in the report text.
const FLOATING_WIDGET_FIX_RE =
  /(chat (bubble|widget|launcher|icon|button)|loyalty badge|rewards badge|floating (badge|icon|widget|button)|back to top)/i;
const REPOSITION_RE = /\b(move|relocate|reposition|shift|tuck|stack|space|separate|collapse)\b/i;

function isFloatingWidgetRepositionFix(text: string): boolean {
  return FLOATING_WIDGET_FIX_RE.test(text) && REPOSITION_RE.test(text);
}

// Fixes that call for photography the store has not given us. The model cannot
// honour these honestly: asked to "add a lifestyle photo showing the plant in a
// garden bed", it invented a garden scene and wedged it between the star rating
// and the buy button, which is both fabricated imagery and a layout no
// storefront uses. The finding still reads perfectly well as advice, so it stays
// in the report and only leaves the image prompt.
const NEW_PHOTOGRAPHY_FIX_RE =
  /(lifestyle|in-?context|in-?situ|scale|styled|environment|room|garden|real[- ]world)\s+(photo|image|shot|picture)|add(ing)?\s+(a|an|another|a second|more)\s+(photo|image|picture|shot)|show(ing)?\s+the\s+product\s+(in use|in a|being used)|second\s+(product\s+)?(photo|image)/i;

function needsNewPhotography(text: string): boolean {
  return NEW_PHOTOGRAPHY_FIX_RE.test(text);
}

// Fixes that call for numeric social proof the page does not show. The model
// cannot honour these honestly either: asked to "show a star rating and review
// count", it drew "Rated 4.8/5 by 1,200+ happy gardeners" on a page with no
// rating data anywhere, and the invented-number gate then withheld the image,
// every time. A fix that can only be satisfied by fabricating a number is a
// guaranteed withhold, so it stays in the report as advice (install a reviews
// app, surface real counts) and leaves the image prompt.
const INVENTED_PROOF_FIX_RE =
  /(star.?rating|review\s+count|((\d[\d,]*\+?|number|count)\s+of\s+)?(customer|buyer|gardener|shopper)s?\s+(count|served|badge)|social\s+proof|trust\s+(badge|bar|strip)|testimonial|(add|show|display|include|surface).{0,40}\b(reviews?|ratings?)\b)/i;

function needsInventedProof(text: string): boolean {
  return INVENTED_PROOF_FIX_RE.test(text);
}

function recommendationsFor(
  section: { section_details: Record<string, unknown> | null },
  viewport: Viewport,
): Array<{ text: string; number: number }> {
  const web = asRecord(asRecord(section.section_details).web);
  const findings = Array.isArray(web.findings) ? web.findings : [];
  return findings
    .filter((f) => {
      const rec = asRecord(f);
      if (rec.hidden === true) return false;
      // Only this viewport's fixes (plus shared 'both') drive its "after".
      const vp = String(rec.viewport ?? "both");
      return vp === "both" || vp === viewport;
    })
    .map((f, idx) => {
      const rec = asRecord(f);
      const text = typeof rec.recommendation === "string" && rec.recommendation.trim()
        ? rec.recommendation.trim()
        : typeof rec.text === "string"
        ? rec.text.trim()
        : "";
      // idx + 1 is the number the report renders on the Before pin: the UI
      // numbers exactly this filtered list. Keeping it here is what lets the
      // After pins carry the same numbers instead of a parallel numbering.
      return { text, number: idx + 1 };
    })
    .filter((r) => r.text.length > 0);
}

/** Upload a PNG and return its public URL, cache-busted so a regenerate shows
 * the new image immediately at the same path. */
async function uploadPng(sb: SupabaseClient, objectPath: string, bytes: Uint8Array): Promise<string> {
  const { error: uploadErr } = await sb.storage
    .from(STORAGE_BUCKET)
    .upload(objectPath, bytes, { contentType: "image/png", upsert: true });
  if (uploadErr) throw new Error(`upload_failed: ${uploadErr.message}`);
  const { data: pub } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(objectPath);
  const publicUrl = pub?.publicUrl ?? null;
  if (!publicUrl) throw new Error("no_public_url");
  return `${publicUrl}?v=${Date.now()}`;
}

/** Persist one viewport's "after" onto the section row. */
async function saveAfterImage(
  sb: SupabaseClient,
  section: { id: string; section_details: Record<string, unknown> | null },
  viewport: Viewport,
  entry: Record<string, unknown>,
): Promise<void> {
  const details = asRecord(section.section_details);
  const web = asRecord(details.web);
  const images = asRecord(web.after_images);
  images[viewport] = entry;
  web.after_images = images;
  details.web = web;
  await sb.from("audit_sections").update({ section_details: details }).eq("id", section.id);
  section.section_details = details; // keep the in-memory row fresh for this invocation
}

// Generates + stores the "after" for one specific (section, viewport). When
// referenceAfterUrl is set (the sibling viewport's approved after), the model
// mirrors those same changes so the concepts stay consistent across devices.
async function generateOne(
  sb: SupabaseClient,
  auditId: string,
  clientId: string,
  section: { id: string; section_key: string; section_details: Record<string, unknown> | null },
  apiKey: string,
  viewport: Viewport,
  sourceUrl: string,
  referenceAfterUrl?: string,
  belowFoldUrl?: string | null,
  sourceElements?: CapturedEl[],
  htmlSource?: { pageUrl?: string | null; outline?: unknown; variantId?: string | null },
  photos?: PhotoBox[],
  textLocks?: PhotoBox[],
): Promise<{ url: string | null; viewport: Viewport }> {
  const meta = PAGE_SECTIONS.find((s) => s.key === section.section_key);
  if (!meta) throw new Error(`section ${section.section_key} is not a page section`);

  const path = `${clientId}/${auditId}/web/after_${meta.page_type}_${viewport}.png`;

  // ---------------------------------------------------------------------------
  // ENGINE 1: edit the real page. RETIRED as the default on 2026-08-08: the
  // header rebuild kept producing mangled headers (duplicated cart icons, the
  // hamburger overlapping the logo) and set_text truncated product titles, so
  // the concept looked worse than the original. The code stays as a backup;
  // flip this constant to try it again, and web_html_after_spike still drives
  // it directly for experiments. The image model is the default again, with
  // its hard photo gate, focused retry and verify-before-publish intact.
  // ---------------------------------------------------------------------------
  const USE_HTML_ENGINE = false;
  // Photo-lock compositing (mask photos to magenta slots, restore after
  // generation). Flip off to return to pure prompt-and-gate generation.
  const USE_COMPOSITE = true;
  const allRecPairs = recommendationsFor(section, viewport);
  const allRecs = allRecPairs.map((r) => r.text);
  // Photography the store never gave us is the one thing a DOM edit still cannot
  // honestly produce. Floating-widget moves, by contrast, are exactly what this
  // engine does best (a real DOM move cannot duplicate the widget), so unlike the
  // image path they are NOT withheld here.
  const htmlRecPairs = allRecPairs.filter((r) => !needsNewPhotography(r.text)).slice(0, 8);
  const htmlRecs = htmlRecPairs.map((r) => r.text);
  let htmlError: string | null = null;
  // The cart is the one page whose capture drives a multi-hop add-to-cart flow,
  // so it can only afford ONE page load per invocation. With a stored outline
  // that is exactly what it costs; without one the engine would have to probe
  // first, and two cart flows blew the edge function's 150s ceiling. So the cart
  // requires the outline its capture now saves, and older audits fall back.
  const cartNeedsOutline = meta.page_type === "cart" && !isUsableOutline(htmlSource?.outline);
  if (cartNeedsOutline) htmlError = "cart_without_stored_outline";
  if (!USE_HTML_ENGINE) htmlError = "html_engine_disabled";
  if (USE_HTML_ENGINE && htmlSource?.pageUrl && htmlRecs.length > 0 && !cartNeedsOutline) {
    try {
      const run = await runHtmlAfter({
        pageUrl: htmlSource.pageUrl,
        pageLabel: meta.label,
        viewport,
        recommendations: htmlRecs,
        outline: htmlSource.outline,
        // The cart drawer is empty unless something is added first.
        cartAdd: meta.page_type === "cart" ? { variantId: htmlSource.variantId ?? null } : undefined,
        proxyTier: meta.page_type === "cart" ? "residential" : undefined,
        // Leave room inside the edge function's own 150s budget.
        timeoutMs: meta.page_type === "cart" ? 110_000 : undefined,
      });
      if (run.ok) {
        const summary = summarizeEditReport(run.report, htmlRecs);
        const publishedUrl = await uploadPng(sb, path, run.png);
        // Numbered pins for the After image: one box per finding, carrying the
        // SAME number the report shows on the Before, so a reader can see what
        // changed instead of hunting for it. Largest box wins when several edits
        // served one finding.
        const markerByNumber = new Map<number, { x: number; y: number; w: number; h: number }>();
        for (const op of run.report.ops ?? []) {
          if (!op.applied || !op.box || !op.fix_index) continue;
          const pair = htmlRecPairs[Number(op.fix_index) - 1];
          if (!pair) continue;
          const prev = markerByNumber.get(pair.number);
          if (!prev || op.box.w * op.box.h > prev.w * prev.h) markerByNumber.set(pair.number, op.box);
        }
        const markers = [...markerByNumber.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([number, box]) => ({ index: number, ...box }));
        const skippedPhotography = allRecs.filter(needsNewPhotography);
        await saveAfterImage(sb, section, viewport, {
          url: publishedUrl,
          engine: "html",
          generated_at: new Date().toISOString(),
          verify: {
            engine: "html",
            // Deterministic, not judged from a picture: the in-page runtime
            // measured every photo before and after the edits.
            photos: run.report.photos,
            ops: run.report.ops,
            brand: run.report.brand,
            captures: run.captures,
          },
          unapplied: [
            ...summary.unapplied,
            ...skippedPhotography.map((r) => `Needs new photography, which a layout edit cannot show: ${r}`),
          ],
          applied_count: summary.applied.length,
          total_count: allRecs.length,
          markers,
        });
        console.log(
          `after-image ${meta.label}/${viewport}: HTML engine applied ${summary.applied.length}/${htmlRecs.length} fixes, ${markers.length} marker(s), photos unchanged (${run.report.photos?.before ?? "?"})`,
        );
        return { url: publishedUrl, viewport };
      }
      htmlError = `${run.stage}: ${run.error}`;
      // The guards refusing EVERY edit means each one would have broken the page:
      // a taller announcement bar, a collision, a cart drawer growing. Handing
      // that page to the image model, which has none of those guards, trades a
      // missing concept for a probably-broken one, and the cart is exactly where
      // the image model always did its worst work. So withhold instead.
      if (run.error === "all_edits_guarded") {
        console.warn(`after-image ${meta.label}/${viewport}: withheld, every edit would have broken the page`);
        await saveAfterImage(sb, section, viewport, {
          url: null,
          engine: "html",
          error: "all_edits_guarded",
          generated_at: new Date().toISOString(),
          verify: { engine: "html", ops: run.report?.ops ?? null },
          unapplied: htmlRecs,
          applied_count: 0,
          total_count: allRecs.length,
        });
        return { url: null, viewport };
      }
    } catch (e) {
      htmlError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
    console.warn(`after-image ${meta.label}/${viewport}: HTML engine failed (${htmlError}), falling back to the image model`);
  } else if (!htmlSource?.pageUrl) {
    htmlError = "no_page_url_on_snapshot";
  }

  // ---------------------------------------------------------------------------
  // ENGINE 2 (fallback): regenerate the screenshot with the image model, with the
  // hard photo gate that withholds an image whose photos came back damaged.
  // ---------------------------------------------------------------------------

  const srcRes = await fetch(sourceUrl);
  if (!srcRes.ok) throw new Error(`fetch_source_${srcRes.status}`);
  let srcPng: Uint8Array = new Uint8Array(await srcRes.arrayBuffer());

  // SHAPE CONTRACT. The model can only output its supported aspect ratios; fed
  // a 704x1530 phone shot with no imageConfig it rendered at default 1K in a
  // shape of its own choosing, which is where the unreadable text, blank
  // bottom halves, and sliced banners came from. Crop the source, top-anchored,
  // to the tallest supported ratio that fits (the first fold survives; fixes
  // live there), then request EXACTLY that ratio at 2K. The verifier must judge
  // against the cropped source, or it flags the missing bottom as a defect.
  // Photos and text locks travel through the crop as ONE list (the crop only
  // touches boxes, and both kinds are boxes); they split again afterwards
  // because only photos get the sliver filter and only text gets the prepare
  // treatment. Text locks are tagged by their `kind` field.
  let effectiveLocks: PhotoBox[] = [
    ...(Array.isArray(photos) ? photos : []),
    ...(Array.isArray(textLocks) ? textLocks : []),
  ];
  let outputRatio: string | undefined;
  let verifySourceUrl = sourceUrl;
  try {
    const shaped = await cropToSupportedRatio(srcPng, effectiveLocks);
    outputRatio = shaped.ratio;
    if (shaped.cropped) {
      srcPng = shaped.png;
      effectiveLocks = shaped.photos;
      verifySourceUrl = await uploadPng(
        sb,
        `${clientId}/${auditId}/web/after_${meta.page_type}_${viewport}_source.png`,
        srcPng,
      );
    }
  } catch (e) {
    console.warn(`after-image ${meta.label}/${viewport}: ratio crop failed (${e instanceof Error ? e.message : e}), sending unshaped`);
  }
  const effectivePhotos = effectiveLocks.filter((b) => !b.kind);
  const effectiveTextLocks = effectiveLocks.filter((b) => !!b.kind);

  let refPng: Uint8Array | undefined;
  if (referenceAfterUrl) {
    try {
      const r = await fetch(referenceAfterUrl);
      if (r.ok) refPng = new Uint8Array(await r.arrayBuffer());
    } catch {
      // best effort: fall back to a standalone (non-mirrored) generation
    }
  }

  // Context only: the real content just below this crop, so the redesign can
  // continue it instead of inventing filler or leaving the bottom empty.
  let belowPng: Uint8Array | undefined;
  if (belowFoldUrl) {
    try {
      const r = await fetch(belowFoldUrl);
      if (r.ok) belowPng = new Uint8Array(await r.arrayBuffer());
    } catch {
      // best effort: the prompt falls back to "do not invent filler"
    }
  }

  const allRecommendations = allRecs;
  // Drop floating-widget repositioning fixes: the model reliably duplicates the
  // widget instead of moving it. Everything else is still applied.
  const applicable = allRecommendations.filter((r) =>
    !isFloatingWidgetRepositionFix(r) && !needsNewPhotography(r) && !needsInventedProof(r)
  );
  const skippedWidgetFix = allRecommendations.some(isFloatingWidgetRepositionFix);
  const skippedPhotoFix = allRecommendations.some(needsNewPhotography);
  const skippedProofFixes = allRecommendations.filter(needsInventedProof);
  if (skippedProofFixes.length > 0) {
    console.log(
      `after-image ${meta.label}/${viewport}: ${skippedProofFixes.length} social-proof fix(es) left to the report text (the page shows no rating data to draw)`,
    );
  }
  // Cap how many fixes one image tries to show. Asking for every fix at once
  // makes the model shrink type and cram blocks together, which reads as a
  // cluttered page and undercuts the very point of the concept. Findings are
  // written highest-impact first, so the top few are the ones worth depicting;
  // the rest still appear as text in the report. A phone screen holds less, so
  // its budget is tighter.
  // Raised from 4/5: anything past the cap is never sent to the model, so a
  // page with six findings silently lost the tail every time. The cap exists
  // only to stop one prompt asking for so much that the model starts reflowing
  // the page (which is how photos got rescaled), so it is generous, not tight.
  const MAX_FIXES = viewport === "mobile" ? 6 : 7;
  const recommendations = applicable.slice(0, MAX_FIXES);
  // Everything past the cap is never sent to the model, so it can never appear.
  // Record it rather than letting the counts imply it was done.
  const notAttempted = applicable.slice(MAX_FIXES);
  if (notAttempted.length > 0) {
    console.log(
      `after-image ${meta.label}/${viewport}: ${notAttempted.length} fix(es) over the ${MAX_FIXES} cap were not attempted`,
    );
  }
  const basePrompt = buildEditPrompt(
    meta.label,
    recommendations,
    Boolean(refPng),
    viewport,
    meta.page_type as WebPageKind,
    skippedWidgetFix,
    Boolean(belowPng),
    photoShapeNote(sourceElements, pngSize(srcPng)),
    skippedPhotoFix,
  );

  // PHOTO-LOCK COMPOSITING. The model cannot reproduce a photograph exactly, so
  // every photo it repaints drifts and the gate withholds the image. Instead:
  // paint each photo (from the capture-time inventory) as a solid magenta slot,
  // generate from THAT, and paste the client's own pixels back into the slots
  // afterwards. The model never sees a photo, so it cannot damage one. If it
  // destroys a slot anyway, or invents an extra one, the restore reports it and
  // the whole candidate is rejected by arithmetic, not by a vision judge.
  // A photo whose box is a sliver clipped by the bottom of the shot (a product
  // row just peeking into frame) cannot be a mandatory slot: fixes routinely
  // reflow exactly that band ("show the first products without scrolling"), the
  // model redraws it, and the dead sliver slot rejected every masked attempt on
  // the first live run. Leave slivers unmasked; the vision gate still watches
  // that region.
  const srcDims = pngSize(srcPng);
  const photoLocks = effectivePhotos.filter((p) => {
    if (p.y + p.h < 98) return true; // not clipped by the bottom of the shot
    // Clipped photos are slivers only when MOST of the photo is below the crop,
    // judged from the file's intrinsic ratio (percent boxes use different
    // denominators per axis, so this needs real pixels). The first cut used a
    // flat height threshold and it swallowed fully-visible product cards.
    const ar = (p as PhotoBox & { natural_ar?: number | null }).natural_ar;
    if (typeof ar === "number" && ar > 0 && srcDims) {
      const wPx = (p.w / 100) * srcDims.w;
      const visibleHPx = (p.h / 100) * srcDims.h;
      return visibleHPx >= (wPx / ar) * 0.55;
    }
    return p.h > 18;
  });
  // Photos plus must-not-change text, one lock list: text boxes expanded to
  // survivable sizes, text a fix explicitly targets left editable, overlapping
  // locks merged. From here down the pipeline does not care which is which.
  const lockablePhotos = srcDims
    ? prepareLockBoxes({
      photos: photoLocks,
      textLocks: effectiveTextLocks,
      // Only fixes that will actually run can justify unlocking their target
      // text; anything past the cap never reaches the model.
      recommendations,
      dims: srcDims,
    })
    : photoLocks;
  const lockedTextCount = lockablePhotos.filter((b) => !!b.kind).length;
  const compositing = USE_COMPOSITE && lockablePhotos.length > 0;
  let genSrc: Uint8Array = srcPng;
  let lockNote = "";
  if (compositing) {
    try {
      const m = await maskPhotos(srcPng, lockablePhotos);
      genSrc = m.png;
      lockNote = lockSlotsPrompt(lockablePhotos.length, lockedTextCount);
    } catch (e) {
      // Mask failure just means generating the old way, with the old gate.
      console.warn(`after-image ${meta.label}/${viewport}: mask failed (${e instanceof Error ? e.message : e}), generating unmasked`);
      genSrc = srcPng;
      lockNote = "";
    }
  }

  // Retries are judged at a scratch path and only promoted if they win, so a
  // rejected retry is never, even briefly, the live image at the canonical URL.
  const candidatePath = `${clientId}/${auditId}/web/after_${meta.page_type}_${viewport}_candidate.png`;
  const storeAt = (objectPath: string, bytes: Uint8Array) => uploadPng(sb, objectPath, bytes);
  const store = (bytes: Uint8Array) => storeAt(path, bytes);

  const shapeNote = viewport === "mobile"
    ? "Your previous attempt came back in the WRONG SHAPE: it was a wide desktop-style layout, but this is a PHONE screenshot. Output a tall, narrow, single-column phone image with the same aspect ratio as the source."
    : "Your previous attempt came back in the WRONG SHAPE. Output a wide desktop image with the same aspect ratio as the source.";

  // Gemini intermittently answers with text and no image for the same input:
  // two identical calls on the Power Planter product page gave one image and one
  // gemini_no_image_returned. Left alone that was a coin flip which either 500'd
  // the whole generation or, inside the corrective retry, silently cancelled it.
  // Same prompt, one more go, before treating it as a real failure.
  // Per-generation record of the last composite restore, persisted into verify.
  let compositeInfo: { slots: number; restored: number; fallback?: string } | null = null;
  // Every attempt's outcome, persisted into verify.composite_attempts. The
  // bc0d9a4e audit came back with restored:0 on all 8 sections and the only
  // trail was console.warn lines the log API never shows; whether the masked
  // pass died on a model 429, destroyed slots, or a matcher rejection has to
  // be answerable from the DB row.
  const compositeAttempts: Array<Record<string, unknown>> = [];
  // Pro tier first for its text rendering; downgraded in-flight if unavailable.
  let imageModel = GEMINI_IMAGE_MODEL_PRO;
  // COST GUARDRAIL. One image could previously spend ~10 generations: two masked
  // attempts plus an unmasked fallback, then that whole ladder again for a
  // wrong-shape reshoot, again for the corrective retry, plus a polish pass.
  // Times eight sections that is ~80 generations per audit, which is how a 25 EUR
  // top-up disappeared in an afternoon. Every generation for this image is
  // counted against one hard cap, so a pathological page costs a known maximum
  // instead of whatever the retry ladders happen to want.
  const MAX_GENERATIONS_PER_IMAGE = 6;
  let generations = 0;
  const spendGeneration = () => {
    if (generations >= MAX_GENERATIONS_PER_IMAGE) {
      throw new Error(`generation_budget_exhausted (${MAX_GENERATIONS_PER_IMAGE} per image)`);
    }
    generations += 1;
  };
  const gemini = async (prompt: string, referencePng?: Uint8Array) => {
    let lastErr: unknown;
    // When compositing, a masked failure falls back to one unmasked pass (the
    // pre-composite behaviour, still covered by the hard photo gate below)
    // rather than failing the whole generation.
    // Two masked tries, not three: the pro model is slower per generation, and
    // a worst case of three masked + one unmasked + verify passes blew the edge
    // function's 150s ceiling with nothing published at all.
    const plans: Array<{ masked: boolean; tries: number }> = compositing
      ? [{ masked: true, tries: 2 }, { masked: false, tries: 1 }]
      : [{ masked: false, tries: 3 }];
    for (const plan of plans) {
      for (let attempt = 1; attempt <= plan.tries; attempt++) {
        try {
          // Replaying the identical request replays the identical odds, so each
          // attempt changes something: attempt 2 raises the temperature, attempt 3
          // also drops the below-fold context image so the request is lighter and
          // the model has one less reason to answer in prose about it.
          spendGeneration();
          const candidates = await geminiEditImage(
            plan.masked ? genSrc : srcPng,
            plan.masked && lockNote ? `${prompt}\n\n${lockNote}` : prompt,
            apiKey,
            {
              model: imageModel,
              // No sibling reference on masked attempts: in auto mode every
              // mobile generation carries the desktop after, full of real
              // photos, and that invites the model to paint photos over the
              // slots. The unmasked fallback keeps it for cross-viewport
              // consistency.
              referencePng: plan.masked ? undefined : referencePng,
              belowFoldPng: attempt < 3 ? belowPng : undefined,
              temperature: attempt === 1 ? 0.4 : 0.7,
              // The shape contract, but ONLY on unmasked attempts. Asking for an
              // explicit shape makes the model re-render the page rather than
              // edit it, which erased the magenta lock slots every single time:
              // measured purity 0.997 without imageConfig versus 0.0 with it, on
              // the same page and prompt. Masked attempts therefore request no
              // shape and get conformed to the source's exact pixels in code
              // afterwards, which is both exact and free.
              aspectRatio: plan.masked ? undefined : outputRatio,
              imageSize: plan.masked ? undefined : "1K",
            },
          );
          const candidate = candidates[0];
          if (!candidate) {
            lastErr = new Error("gemini_no_image_returned (finish=none)");
            compositeAttempts.push({ masked: plan.masked, model: imageModel, error: "no_image_returned" });
          } else if (!plan.masked) {
            if (compositing) compositeInfo = { slots: lockablePhotos.length, restored: 0, fallback: "unmasked" };
            compositeAttempts.push({ masked: false, model: imageModel, ok: true });
            return candidate;
          } else {
            // Impose the shape here, since the masked request deliberately did
            // not ask for one. Doing it BEFORE the restore also means slot
            // geometry is compared in the source's own coordinate space.
            const conformed = srcDims ? await conformToSize(candidate, srcDims) : candidate;
            // Paste the client's own photos into the slots the model kept. All
            // slots restored and no stray slot pixels means the photos are the
            // originals by construction; anything else rejects this candidate.
            const restored = await restorePhotos(srcPng, conformed, lockablePhotos);
            const missing = restored.report.filter((r) => !r.found).length;
            const leftover = restored.leftoverPx;
            if (missing === 0 && leftover < 1500) {
              compositeInfo = { slots: restored.report.length, restored: restored.report.length };
              compositeAttempts.push({ masked: true, model: imageModel, ok: true });
              return restored.png;
            }
            lastErr = new Error(`composite_slots_failed (missing=${missing}, leftover_px=${leftover})`);
            compositeAttempts.push({
              masked: true,
              model: imageModel,
              missing,
              leftover_px: leftover,
              // Purity per slot separates "model destroyed the slot" from "the
              // matcher rejected a rectangle it found".
              purities: restored.report.map((r) => r.purity),
            });
          }
        } catch (e) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          compositeAttempts.push({ masked: plan.masked, model: imageModel, error: msg.slice(0, 160) });
          // The spend cap is not a transient failure: retrying is precisely what
          // it exists to prevent, so it propagates immediately.
          if (/generation_budget_exhausted/.test(msg)) throw e;
          // A 429 on the pro tier (rate limit or unfunded preview) must NOT be
          // retried against the same wall: on the bc0d9a4e audit it burned every
          // masked attempt in seconds and the whole audit shipped via the
          // unmasked fallback, which the photo gate then rightly withheld.
          // Downgrade to flash and redo the attempt. Checked BEFORE the bail
          // regex so "prepayment credits are depleted" never hard-fails while
          // flash still has credit.
          if (imageModel !== GEMINI_IMAGE_MODEL && /429|RESOURCE_EXHAUSTED|prepayment credits|rate.?limit/i.test(msg)) {
            console.warn(`after-image: ${imageModel} throttled/unfunded (${msg.slice(0, 100)}), downgrading to ${GEMINI_IMAGE_MODEL}`);
            imageModel = GEMINI_IMAGE_MODEL;
            attempt--;
            continue;
          }
          // The pro tier may not exist for this key (wrong id, no access): drop
          // to the flash model and redo this attempt rather than failing.
          if (imageModel !== GEMINI_IMAGE_MODEL && /not[_ ]?found|does not exist|NOT_FOUND|permission|unsupported|invalid.{0,20}model/i.test(msg)) {
            console.warn(`after-image: model ${imageModel} unavailable (${msg.slice(0, 100)}), falling back to ${GEMINI_IMAGE_MODEL}`);
            imageModel = GEMINI_IMAGE_MODEL;
            attempt--;
            continue;
          }
          // Only bail on failures a retry cannot change: hard blocks and infra.
          if (/timeout|abort|block=|safety|prohibited|api_key|quota/i.test(msg)) throw e;
        }
        console.warn(
          `after-image: gemini ${plan.masked ? "masked " : ""}attempt ${attempt} failed (${String(lastErr).slice(0, 120)}), retrying`,
        );
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("gemini_no_image_returned");
  };

  const startedAt = Date.now();
  let edited = await gemini(basePrompt, refPng);
  // Did the FIRST generation come back as a clean composite (every photo slot
  // restored from the client's own pixels)? If so its photos are correct by
  // construction, and that is worth more than any extra fix a later attempt
  // might add: a corrective retry can only fall back to an unmasked generation,
  // which forfeits the guarantee and then loses to the photo gate. Measured on
  // this exact page: attempt 1 composited cleanly, the retry went unmasked, and
  // the whole image was withheld despite already being good.
  const firstCi = compositeInfo as { slots: number; restored: number; fallback?: string } | null;
  const firstWasCleanComposite = firstCi !== null && !firstCi.fallback && firstCi.restored === firstCi.slots;

  // Deterministic shape gate BEFORE anything else: a mobile source that comes
  // back landscape is unusable, and no amount of prompting reliably prevents it.
  // Regenerate once without the sibling reference, which is what tempts the model
  // to copy the other device's layout in the first place.
  if (wrongShape(srcPng, edited)) {
    try {
      const reshot = await gemini(`${basePrompt}\n\n${shapeNote}`, undefined);
      if (!wrongShape(srcPng, reshot)) edited = reshot;
      else {
        // Still the wrong device shape. Storing it would show a desktop layout
        // under a "mobile" toggle, so record the failure and show Before only.
        throw new Error("wrong_shape_after_retry");
      }
    } catch (e) {
      if (e instanceof Error && e.message === "wrong_shape_after_retry") throw e;
      throw new Error("wrong_shape");
    }
  }

  let bustedUrl = await store(edited);

  // Grade the result and give the model ONE corrective attempt when it skipped a
  // fix or introduced a defect. Capped at one retry to stay inside the edge
  // function's wall clock. The retry gets a strictly more specific prompt, so if
  // it succeeds we keep it; if the retry itself fails we keep the first attempt.
  const check = await gradeWithPhotoCheck(verifySourceUrl, bustedUrl, recommendations, viewport);
  // Persisted with the image so a bad result can be diagnosed from the DB:
  // did the judge miss the problem, or see it and ship the lesser evil anyway?
  const verify: Record<string, unknown> = {
    attempt1: { missing: check.missing, defects: check.defects },
    retry_ran: false,
    published: "attempt1",
    // How the photos were protected: slots restored by the compositor, or the
    // unmasked fallback (photo gate only), or absent entirely (no inventory).
    composite: compositeInfo,
  };
  // The bytes and verdict of whatever is currently published, for the polish pass.
  let finalBytes = edited;
  let finalVerdict = check;
  if (firstWasCleanComposite && !check.ok) {
    // Keep the guarantee, skip the retry. Also saves the two or three
    // generations the ladder would have spent losing it.
    verify.retry_skipped = "first attempt composited cleanly; photos are the client's own pixels";
  }
  if (!check.ok && !firstWasCleanComposite) {
    try {
      const photoTrouble = check.defects.some(isPhotoDefect);
      // The retry never repeats the first prompt verbatim: same prompt, same
      // model, same temperature just reproduces the first failure.
      // - Photo trouble: keep EVERY fix and add an absolute photo lock naming
      //   the exact photos that were damaged. The old fewer-fixes mode asked
      //   for less to protect the photos, and it did the opposite: on the case
      //   that motivated it, the retry deleted the product photo and the
      //   thumbnail gallery outright, while honestly applying 1 of 3 fixes.
      //   Sacrificing fixes bought nothing; the accept guard below is what
      //   actually protects the published image.
      // - Missing fixes only: re-ask for ONLY what was missed, framed as small
      //   surgical edits to an otherwise-final page. The full-list retry kept
      //   skipping the same small additions (a star rating line) it skipped the
      //   first time.
      const focusedOnMissing = !photoTrouble && check.missing.length > 0;
      const retryFixes = focusedOnMissing ? check.missing : recommendations;
      const retryBase = focusedOnMissing
        ? buildEditPrompt(
          meta.label,
          retryFixes,
          Boolean(refPng),
          viewport,
          meta.page_type as WebPageKind,
          skippedWidgetFix,
          Boolean(belowPng),
          photoShapeNote(sourceElements, pngSize(srcPng)),
    skippedPhotoFix,
        )
        : basePrompt;
      const lead = photoTrouble
        ? `IMPORTANT, THIS IS A SECOND ATTEMPT AND YOUR LAST ONE DAMAGED THE IMAGERY. ${check.feedback}\n\nThis time, every photograph is ABSOLUTELY UNTOUCHABLE: copy each one across pixel-faithful, at the same shape, the same crop, the same framing and the same proportions as the original. Never zoom, re-centre, reshape or remove a photo, and never let one be sliced by an edge. Apply ALL of the fixes listed above by taking space from padding, headings and spacing only, never from inside a photograph. A fix is only done right if every photo survives it unchanged.`
        : focusedOnMissing
          ? `IMPORTANT, THIS IS A SECOND ATTEMPT. Your previous attempt was good EXCEPT that the small number of fixes listed above were not visible in it. Treat the page as already final: make ONLY those additions or changes, clearly visible, and change NOTHING else anywhere on the page.`
          : `IMPORTANT, THIS IS A SECOND ATTEMPT. ${check.feedback}\n\nProduce the corrected screenshot with every fix above clearly visible and no duplicated or leftover elements.`;
      // The reference stays even in photo mode: it is what keeps the two
      // viewports showing the same redesign, and the run that dropped it is the
      // one whose retry deleted the photos. The photo lock in the lead, plus the
      // accept guard, are the protections that actually held.
      const retried = await gemini(`${retryBase}\n\n${lead}`, refPng);
      // Captured NOW, before polish can reassign it: whether the retry's
      // generation restored every slot. A clean composite means every photo in
      // the retry is the client's own pixels BY CONSTRUCTION, so the vision
      // judge's photo verdicts on it are noise. Without this, a retry that
      // achieved the guarantee was rejected because the judge flagged a
      // legitimately-shortened banner as a re-crop, and the damaged unmasked
      // first attempt stayed published and was then withheld (live audit
      // 611dc75f, homepage desktop: attempts show masked ok on the retry,
      // published stayed attempt1, section withheld).
      const retryCi = compositeInfo as { slots: number; restored: number; fallback?: string } | null;
      const retryCleanComposite = retryCi !== null && !retryCi.fallback && retryCi.restored === retryCi.slots;
      // Never let a corrective attempt regress the device shape.
      if (!wrongShape(srcPng, retried)) {
        // Judge the retry at the scratch path; the canonical image is untouched
        // until the retry has actually won.
        const candidateUrl = await storeAt(candidatePath, retried);
        // Grade the retry too. It used to be accepted blind, so a second attempt
        // that still cropped the photos shipped anyway, sometimes worse than the
        // first.
        // Grade the retry against the FULL fix list, not just what it was asked
        // to do. A fewer-fixes retry that silently drops fixes the first attempt
        // had must lose points for them, or "asked for less" wins for free.
        const recheck = await gradeWithPhotoCheck(verifySourceUrl, candidateUrl, recommendations, viewport);
        verify.retry_ran = true;
        verify.retry_mode = photoTrouble ? "photo_lock" : focusedOnMissing ? "missing_only" : "full";
        verify.retry = { missing: recheck.missing, defects: recheck.defects, clean_composite: retryCleanComposite };
        // When photos were the problem, the retry has to actually heal the
        // photos to win, not merely tie on the overall score. Both verdicts are
        // graded against the full fix list, so any fix the retry drops counts
        // against it.
        const photoBefore = check.defects.filter(isPhotoDefect).length;
        // A clean-composite retry has zero photo damage by arithmetic, whatever
        // the judge says; scoring it on the judge's photo verdicts let a
        // guaranteed-intact retry lose to a damaged first attempt.
        const photoAfter = retryCleanComposite ? 0 : recheck.defects.filter(isPhotoDefect).length;
        const recheckScored = retryCleanComposite
          ? { ...recheck, defects: recheck.defects.filter((d) => !isPhotoDefect(d)) }
          : recheck;
        const accept = photoTrouble
          ? photoAfter < photoBefore && verifyScore(recheckScored) <= verifyScore(check)
          : verifyScore(recheckScored) <= verifyScore(check);
        if (accept) {
          bustedUrl = await store(retried);
          verify.published = "retry";
          finalBytes = retried;
          finalVerdict = recheck;
        }
        // Scratch object is transient either way; ignore cleanup failures.
        await sb.storage.from(STORAGE_BUCKET).remove([candidatePath]).catch(() => {});
      }
    } catch (e) {
      // Retry failed outright: the first attempt is already stored, keep it.
      // Record WHY, because a bare catch here made "the verifier caught the
      // crop but nothing was retried" impossible to diagnose from the row.
      verify.retry_error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
  }

  // Final polish. Whatever won can still be missing small fixes, because
  // fewer-fixes mode sacrifices the tail of the list by design; the star-rating
  // line lost this way three times in a row on one store. Editing the
  // near-final AFTER itself ("the page is final, add only this, change nothing
  // else") is the most reliable operation the image model does, so spend one
  // more generation when something is missing and the wall clock allows it.
  const dupWidget = finalVerdict.defects.some(
    (d) => /duplicat/i.test(d) && /widget|bubble|badge|icon/i.test(d),
  );
  // Never polish a fully-composited image: polish regenerates WITHOUT masking,
  // so it trades photos that are provably the client's own pixels for a chance
  // at one more fix. On the first live run it won publication and re-damaged
  // the banner the compositor had just restored, which un-published the page.
  // Same care as the gate: judge what is actually published, not whatever a
  // losing later attempt left behind in compositeInfo.
  const ciNow = (verify.published === "attempt1"
    ? firstCi
    : compositeInfo) as { slots: number; restored: number; fallback?: string } | null;
  const compositeClean = ciNow !== null && !ciNow.fallback && ciNow.restored === ciNow.slots;
  if (!compositeClean && (finalVerdict.missing.length > 0 || dupWidget) && Date.now() - startedAt < 90_000) {
    try {
      const polishFixes = [
        ...finalVerdict.missing,
        ...(dupWidget
          ? [
            "Remove the duplicated floating widgets: each floating element (chat bubble, loyalty or rewards badge, back-to-top button) must appear exactly ONCE, in one corner.",
          ]
          : []),
      ];
      const polishPrompt = [
        `This image is a nearly finished redesign of the ${meta.label} of an e-commerce store. Treat it as FINAL.`,
        `Make ONLY these small corrections, each clearly visible, and change NOTHING else anywhere on the page:`,
        polishFixes.map((r, i) => `${i + 1}. ${r}`).join("\n"),
        `Keep every photograph, heading, button, and layout region exactly as it is. Do not re-lay-out anything. Output the full corrected screenshot at the same size and aspect ratio.`,
      ].join("\n\n");
      spendGeneration();
      const polished = (await geminiEditImage(finalBytes, polishPrompt, apiKey, {
        model: imageModel,
        aspectRatio: outputRatio,
        imageSize: "1K",
      }))[0];
      if (!wrongShape(srcPng, polished)) {
        const polishUrl = await storeAt(candidatePath, polished);
        const pcheck = await gradeWithPhotoCheck(verifySourceUrl, polishUrl, recommendations, viewport);
        verify.polish_ran = true;
        verify.polish = { missing: pcheck.missing, defects: pcheck.defects };
        // Promote only a strict improvement: photos no worse, total score lower.
        const photosNotWorse =
          pcheck.defects.filter(isPhotoDefect).length <= finalVerdict.defects.filter(isPhotoDefect).length;
        if (photosNotWorse && verifyScore(pcheck) < verifyScore(finalVerdict)) {
          bustedUrl = await store(polished);
          verify.published = "polish";
        }
        await sb.storage.from(STORAGE_BUCKET).remove([candidatePath]).catch(() => {});
      }
    } catch {
      // Best effort: the published image is already the best of the earlier attempts.
    }
  }

  // What the judge still could not see in the image we are publishing. Some
  // recommendations are structural (moving a bar into a menu) and the model will
  // not do them however precisely it is asked, so after every pass has run this
  // gets recorded rather than quietly published as if it were applied.
  const publishedVariant = String(verify.published ?? "attempt1");
  const publishedVerdict = asRecord(verify[publishedVariant]);
  const graded = Array.isArray(publishedVerdict.missing) ? (publishedVerdict.missing as string[]) : [];
  // A capped fix is unapplied too, and more definitely so than one the judge
  // merely could not see.
  const unapplied = [...graded, ...notAttempted.map((r) => `Not attempted (over the ${MAX_FIXES}-fix limit for this image): ${r}`)];

  // HARD GATE. Six prompt rules and two judge checks did not stop the model
  // cropping, reshaping, swapping and re-gridding client product photos, because
  // no instruction can guarantee anything from a probabilistic image model. This
  // can: if the photos in the winning candidate are still damaged after every
  // attempt, retry and polish, publish NOTHING. A missing concept image is a gap;
  // a concept image showing a client's product in the wrong shape, or showing a
  // product that is not theirs, is a credibility problem in front of that client.
  // The retry may have generated again, so record the LAST restore that fed the
  // published image rather than whatever attempt 1 happened to do.
  verify.composite = verify.published === "attempt1" ? firstCi : compositeInfo;
  verify.composite_attempts = compositeAttempts;
  // Which model actually produced the published bytes: after a mid-run
  // downgrade "pro vs flash" must never be a guess.
  verify.model = imageModel;
  // Image generations spent on this one image, so the cost of an audit is
  // auditable from the rows instead of reconstructed from a billing page.
  verify.generations = generations;
  // When every slot was restored, the photos in the published image ARE the
  // source pixels, copied by arithmetic. A vision judge disagreeing with that is
  // wrong by construction (it flagged a requested banner trim as a re-crop on
  // the first composited run), so its photo verdicts become informational and
  // only the unmasked fallback still lives or dies by them.
  // The polish pass regenerates from the composited image WITHOUT masking, so a
  // promoted polish forfeits the guarantee and faces the vision gate like any
  // unmasked output.
  // compositeInfo is only ever assigned inside the gemini closure, which TS's
  // control-flow analysis cannot see, so it narrows the variable to its initial
  // null here; the cast restores the declared type.
  // Judge the composite state of the image that is ACTUALLY published. When
  // attempt 1 is what shipped, that is the first generation's state, not
  // whatever a later call left in compositeInfo: a retry that ran and lost still
  // overwrites the variable, which is how a cleanly composited attempt 1 got
  // gated as if it were an unmasked fallback.
  const ci = (verify.published === "attempt1"
    ? firstCi
    : compositeInfo) as { slots: number; restored: number; fallback?: string } | null;
  const photosProvablyOriginal = ci !== null &&
    !ci.fallback &&
    ci.restored === ci.slots &&
    verify.published !== "polish";
  const publishedDefects = Array.isArray(publishedVerdict.defects) ? publishedVerdict.defects as string[] : [];
  const finalPhotoDefects = photosProvablyOriginal ? [] : publishedDefects.filter(isPhotoDefect);
  // Photos were never the only way to ship something unusable. The judge
  // reported "the Checkout button extends beyond the visible frame" on a cart
  // and it published regardless, because only photo defects were ever gated on.
  // A cart with no reachable checkout button fails at the one job the page has,
  // so it is withheld on the same terms. Compositing does not exempt this: the
  // guarantee is about pixels, not layout.
  const finalCriticalDefects = publishedDefects.filter(isCriticalLayoutDefect);
  // On a cart, ask the one question that matters as its OWN pass. The combined
  // rubric missed a sliced-off checkout button twice even with a clause telling
  // it to look, exactly as it used to miss cropped photos before those got a
  // dedicated pass. Cheap (one call, carts only) and it decides the gate.
  if (meta.page_type === "cart") {
    const checkout = await verifyCheckoutVisible(bustedUrl);
    verify.checkout_check = checkout;
    if (!checkout.visible) {
      finalCriticalDefects.push(
        `Checkout button is not fully visible in the cart${checkout.note ? `: ${checkout.note}` : ""}`,
      );
    }
  }
  // Text integrity, every page type. Overlapping headlines, half-erased copy and
  // invented totals all shipped past the combined rubric, and a concept with two
  // headlines smeared over each other or a wrong price is unusable however good
  // the layout is. Same narrow-question approach that finally caught cropped
  // photos and sliced checkout buttons.
  // Judged against the UNCROPPED source plus the second fold, not the 9:16
  // crop: a redesign that pulls the real price or review count up from below
  // the crop line was being withheld for "inventing" numbers the page really
  // shows.
  const textCheck = await verifyTextIntegrity(sourceUrl, bustedUrl, recommendations, belowFoldUrl ?? undefined);
  verify.text_check = textCheck;
  if (!textCheck.clean) {
    finalCriticalDefects.push(
      ...(textCheck.problems.length > 0
        ? textCheck.problems.map((p) => `Text rendered badly: ${p}`)
        : ["Text rendered badly: overlapping, garbled or invented text in the image"]),
    );
  }
  if (finalPhotoDefects.length + finalCriticalDefects.length > 0) {
    console.error(
      `after-image ${meta.label}/${viewport}: withheld after all passes: ${
        [...finalPhotoDefects, ...finalCriticalDefects].join(" | ").slice(0, 300)
      }`,
    );
    const detailsBlocked = asRecord(section.section_details);
    const webBlocked = asRecord(detailsBlocked.web);
    const imagesBlocked = asRecord(webBlocked.after_images);
    imagesBlocked[viewport] = {
      url: null,
      engine: "gemini_fallback",
      html_error: htmlError,
      // Distinguish the two withhold reasons: the editor note for a broken cart
      // should not claim the client's photos were altered.
      error: finalPhotoDefects.length > 0 ? "photo_integrity_failed" : "critical_layout_failed",
      photo_defects: [...finalPhotoDefects, ...finalCriticalDefects],
      generated_at: new Date().toISOString(),
      verify,
    };
    webBlocked.after_images = imagesBlocked;
    detailsBlocked.web = webBlocked;
    await sb.from("audit_sections").update({ section_details: detailsBlocked }).eq("id", section.id);
    section.section_details = detailsBlocked;
    // Leave no half-good image lying at the canonical path.
    await sb.storage.from(STORAGE_BUCKET).remove([path]).catch(() => {});
    return { url: null, viewport };
  }

  const details = asRecord(section.section_details);
  const webOut = asRecord(details.web);
  const afterImages = asRecord(webOut.after_images);
  afterImages[viewport] = {
    url: bustedUrl,
    engine: "gemini_fallback",
    html_error: htmlError,
    generated_at: new Date().toISOString(),
    verify,
    unapplied,
    applied_count: Math.max(0, recommendations.length - graded.length),
    // Count every applicable fix, not just the ones that fitted the cap, so the
    // ratio matches what the report shows the client.
    total_count: applicable.length,
  };
  webOut.after_images = afterImages;
  details.web = webOut;
  await sb.from("audit_sections").update({ section_details: details }).eq("id", section.id);
  section.section_details = details; // keep in-memory row fresh for the same invocation

  return { url: bustedUrl, viewport };
}

async function chainAuto(auditId: string) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    await Promise.race([
      fetch(`${SUPABASE_URL}/functions/v1/web_generate_after`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: SUPABASE_SERVICE_ROLE_KEY,
        },
        body: JSON.stringify({ audit_id: auditId, mode: "auto" }),
      }),
      new Promise((r) => setTimeout(r, 2_000)),
    ]);
  } catch {
    // best effort
  }
}

/** Grade a candidate AND run the dedicated photo-geometry pass, merging the two.
 * Cropping kept surviving the combined rubric, so it gets its own question. */
async function gradeWithPhotoCheck(
  sourceUrl: string,
  candidateUrl: string,
  recommendations: string[],
  viewport: Viewport,
) {
  const [graded, alteredPhotos] = await Promise.all([
    verifyAfterImage(sourceUrl, candidateUrl, recommendations, viewport),
    verifyPhotoFidelity(sourceUrl, candidateUrl, recommendations),
  ]);
  if (alteredPhotos.length === 0) return graded;
  const extra = alteredPhotos.map((p) => `Photo geometry changed: ${p}`);
  const defects = [...graded.defects, ...extra];
  return {
    ok: false,
    defects,
    missing: graded.missing,
    feedback: [
      graded.feedback,
      "Your previous attempt CHANGED THE SHAPE OR CROP of photos, which is never acceptable:\n" +
      extra.map((d, i) => `${i + 1}. ${d}`).join("\n") +
      "\nReproduce every photo with the exact framing, crop and proportions it has in the original. " +
      "Take any space you need from padding or headings, never from inside a photo.",
    ].filter(Boolean).join("\n\n"),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });

  const correlationId = crypto.randomUUID();
  let body: { audit_id?: string; section_key?: string; viewport?: string; mode?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: { code: "bad_request", message: "Invalid JSON" }, correlationId }, { status: 400 });
  }
  const auditId = (body.audit_id ?? "").trim();
  if (!auditId) return json({ ok: false, error: { code: "bad_request", message: "Missing audit_id" }, correlationId }, { status: 400 });

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  // The stall-recovery job reaches us on a schedule with its own secret rather
  // than a Supabase key: the vault's copy of the service role key no longer
  // matches the project's, so a scheduled nudge could not authenticate at all.
  const isService = isServiceRoleAuthorization(token) ||
    await hasCronSecret(req, "web_pipeline_cron_secret");
  if (!isService) {
    try {
      // Staff with audit access only: the door below can publish an audit and
      // everything after it runs as the service role.
      await requireStaffUserId(req, "audits");
    } catch (e) {
      return json({ ok: false, error: { code: "unauthorized", message: e instanceof Error ? e.message : "Unauthorized" }, correlationId }, { status: 401 });
    }
  }

  // THE DOOR, right after auth and before the API key is read, so no caller can
  // spend a generation while afters are off: not the auto chain, not the pg_cron
  // watchdog, not the editor button, not the in-report assistant.
  //
  // Two things still have to happen on the way out, because this function used
  // to own them as the last step of the pipeline:
  //  - web_afters_ready must end up true. The report gate and the watchdog's
  //    after-image phase both select on that flag, so leaving it false traps the
  //    report behind a phase that can never finish.
  //  - the audit must still get its automatic publish. web_finalize_analysis now
  //    does that when afters are off; this is the safety net for an audit that
  //    was finalized before the switch and is being nudged now.
  if (!afterImagesEnabled()) {
    const sbOff = assertServiceClient();
    // Only web audits ever reach this function legitimately, so never flag or
    // publish anything else through this door.
    const { data: offAudit } = await sbOff.from("audits").select("audit_type").eq("id", auditId).maybeSingle();
    if (offAudit?.audit_type === "web") {
      try { await sbOff.from("audits").update({ web_afters_ready: true }).eq("id", auditId); } catch { /* non-fatal */ }
      await autoPublishAudit(sbOff, auditId);
    }
    return json({
      ok: false,
      error: {
        code: "disabled",
        message: "Concept images are turned off for web audits. Reports ship the findings and the store's own screenshots.",
      },
      correlationId,
    }, { status: 200 });
  }

  // Key is managed in admin Settings (app_secrets 'gemini_api_key'); getSecret
  // also honors a GEMINI_API_KEY env override for local testing.
  let apiKey = "";
  try {
    apiKey = (await getSecret("gemini_api_key")).trim();
  } catch {
    apiKey = "";
  }
  if (!apiKey) {
    // Afters can't run without a key; don't leave the report gated on them.
    try { await assertServiceClient().from("audits").update({ web_afters_ready: true }).eq("id", auditId); } catch { /* non-fatal */ }
    await autoPublishAudit(assertServiceClient(), auditId);
    return json({ ok: false, error: { code: "not_configured", message: "Image generation is not configured. Add a Gemini API key in Settings." }, correlationId }, { status: 200 });
  }

  try {
    const sb = assertServiceClient();
    const { data: audit } = await sb.from("audits").select("id, client_id, audit_type").eq("id", auditId).maybeSingle();
    if (!audit) return json({ ok: false, error: { code: "not_found" }, correlationId }, { status: 404 });
    if (audit.audit_type !== "web") return json({ ok: true, correlationId, status: "skipped", reason: "not_web_audit" });
    const clientId = audit.client_id as string;

    const { data: sectionRows } = await sb
      .from("audit_sections")
      .select("id, section_key, section_details")
      .eq("audit_id", auditId)
      .in("section_key", PAGE_SECTIONS.map((s) => s.key));
    const sections = (sectionRows ?? []) as Array<{ id: string; section_key: string; section_details: Record<string, unknown> | null }>;

    const mode = (body.mode ?? "").trim();
    const preferredViewport: Viewport | undefined = body.viewport === "mobile" ? "mobile" : body.viewport === "desktop" ? "desktop" : undefined;

    const afterUrlFor = (
      section: { section_details: Record<string, unknown> | null },
      vp: Viewport,
    ): string | undefined => {
      const entry = asRecord(asRecord(asRecord(section.section_details).web).after_images)[vp];
      const url = asRecord(entry).url;
      return typeof url === "string" && url.length > 0 ? url : undefined;
    };

    // Single-section (on-demand button / explicit regenerate). Generates the
    // requested viewport; a non-primary viewport mirrors the primary's after.
    if (body.section_key) {
      const section = sections.find((s) => s.section_key === body.section_key);
      if (!section) return json({ ok: false, error: { code: "not_found", message: "Section not found" }, correlationId }, { status: 404 });
      const meta = PAGE_SECTIONS.find((s) => s.key === section.section_key);
      if (!meta) return json({ ok: false, error: { code: "bad_request", message: "Not a page section" }, correlationId }, { status: 400 });
      const sources = await listViewportSources(sb, auditId, meta.page_type);
      if (sources.length === 0) return json({ ok: false, error: { code: "no_screenshot", message: "No screenshot available for this page yet." }, correlationId }, { status: 200 });
      const order = orderedViewports(sources, meta.page_type, preferredViewport);
      const primaryVp = order[0];
      const targetVp: Viewport =
        preferredViewport && sources.some((s) => s.viewport === preferredViewport) ? preferredViewport : primaryVp;
      const src = sources.find((s) => s.viewport === targetVp);
      if (!src) return json({ ok: false, error: { code: "no_screenshot", message: "No screenshot for that viewport yet." }, correlationId }, { status: 200 });
      const referenceAfterUrl = targetVp !== primaryVp ? afterUrlFor(section, primaryVp) : undefined;
      const result = await generateOne(
        sb, auditId, clientId, section, apiKey, targetVp, src.url, referenceAfterUrl, src.fold2Url, src.elements,
        { pageUrl: src.pageUrl, outline: src.outline, variantId: src.variantId }, src.photos, src.textLocks,
      );
      return json({ ok: true, correlationId, url: result.url, viewport: result.viewport });
    }

    // Auto: build ordered (section, viewport) units (desktop/primary first so
    // mobile can mirror it), generate the next one missing an after, then
    // self-chain. One image per invocation stays under the edge wall-clock limit.
    if (mode === "auto") {
      type Unit = {
        section: { id: string; section_key: string; section_details: Record<string, unknown> | null };
        viewport: Viewport;
        url: string;
        fold2Url?: string | null;
        primaryViewport: Viewport;
        elements?: CapturedEl[];
        html?: { pageUrl?: string | null; outline?: unknown; variantId?: string | null };
        photos?: PhotoBox[];
        textLocks?: PhotoBox[];
      };
      const units: Unit[] = [];
      for (const meta of PAGE_SECTIONS) {
        const section = sections.find((s) => s.section_key === meta.key);
        if (!section) continue;
        const sources = await listViewportSources(sb, auditId, meta.page_type);
        const order = orderedViewports(sources, meta.page_type);
        for (const vp of order) {
          const src = sources.find((s) => s.viewport === vp);
          if (src) {
            units.push({
              section,
              viewport: vp,
              url: src.url,
              fold2Url: src.fold2Url,
              primaryViewport: order[0],
              elements: src.elements,
              html: { pageUrl: src.pageUrl, outline: src.outline, variantId: src.variantId },
              photos: src.photos,
              textLocks: src.textLocks,
            });
          }
        }
      }
      // A unit is "done" once it has an after url OR a recorded error (so a
      // persistent failure can't loop the chain forever).
      const isDone = (u: Unit) => {
        const entry = asRecord(asRecord(asRecord(u.section.section_details).web).after_images)[u.viewport];
        const e = asRecord(entry);
        return (typeof e.url === "string" && e.url.length > 0) || e.error != null;
      };
      // Gemini sometimes returns no image at all for one call. That is transient,
      // but recording it as a terminal error left a page with no after image and
      // nothing to retry it. Give a unit MAX_UNIT_ATTEMPTS goes before the error
      // becomes terminal; the attempt counter lives on the entry so it survives
      // the self-chaining hops.
      const MAX_UNIT_ATTEMPTS = 3;
      const attemptsFor = (u: Unit) => {
        const entry = asRecord(asRecord(asRecord(u.section.section_details).web).after_images)[u.viewport];
        return Number(asRecord(entry).attempts ?? 0);
      };
      const next = units.find((u) => !isDone(u));
      if (!next) {
        // All after images done (success or recorded error): let the report show.
        try { await sb.from("audits").update({ web_afters_ready: true }).eq("id", auditId); } catch { /* non-fatal */ }
        await autoPublishAudit(sb, auditId);
        return json({ ok: true, correlationId, status: "complete" });
      }

      const referenceAfterUrl =
        next.viewport !== next.primaryViewport ? afterUrlFor(next.section, next.primaryViewport) : undefined;
      try {
        await generateOne(
          sb, auditId, clientId, next.section, apiKey, next.viewport, next.url, referenceAfterUrl, next.fold2Url, next.elements,
          next.html, next.photos, next.textLocks,
        );
      } catch (e) {
        // Count the attempt. Only the LAST one records a terminal error, so a
        // one-off "no image returned" gets retried on the next chained hop
        // instead of leaving the page permanently without an after image.
        const attempts = attemptsFor(next) + 1;
        const message = String(e instanceof Error ? e.message : e).slice(0, 200);
        const terminal = attempts >= MAX_UNIT_ATTEMPTS;
        const details = asRecord(next.section.section_details);
        const webOut = asRecord(details.web);
        const afterImages = asRecord(webOut.after_images);
        afterImages[next.viewport] = {
          url: null,
          attempts,
          last_error: message,
          // Setting `error` is what marks the unit done, so hold it back until
          // the attempts are used up.
          ...(terminal ? { error: message } : {}),
          generated_at: new Date().toISOString(),
        };
        webOut.after_images = afterImages;
        details.web = webOut;
        await sb.from("audit_sections").update({ section_details: details }).eq("id", next.section.id);
        next.section.section_details = details;
        console.error("after-image attempt failed", next.section.section_key, next.viewport, attempts, message);
      }
      const remaining = units.some((u) => !isDone(u));
      if (remaining) await chainAuto(auditId);
      else {
        // Last unit just finished: reveal the report.
        try { await sb.from("audits").update({ web_afters_ready: true }).eq("id", auditId); } catch { /* non-fatal */ }
        await autoPublishAudit(sb, auditId);
      }
      return json({ ok: true, correlationId, status: remaining ? "in_progress" : "complete", section: next.section.section_key, viewport: next.viewport });
    }

    return json({ ok: false, error: { code: "bad_request", message: "Provide section_key or mode:auto" }, correlationId }, { status: 400 });
  } catch (e) {
    const raw = e instanceof Error ? e.message : "Unknown error";
    // Surface an out-of-credits / quota failure as a readable message with a 200,
    // so the report shows what is actually wrong instead of the client's generic
    // "Edge Function returned a non-2xx status code".
    const outOfCredits = /prepayment credits|quota|billing|RESOURCE_EXHAUSTED|gemini_http_429/i.test(raw);
    if (outOfCredits) {
      return json({
        ok: false,
        error: {
          code: "quota_exhausted",
          message: "Image generation is out of credits on the Gemini account. Top up billing in Google AI Studio, then try again.",
        },
        correlationId,
      }, { status: 200 });
    }
    return json({ ok: false, error: { code: "generate_failed", message: raw }, correlationId }, { status: 500 });
  }
});
