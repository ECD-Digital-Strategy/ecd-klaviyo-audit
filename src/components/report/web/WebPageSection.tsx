import { useEffect, useMemo, useState } from 'react';
import { Loader2, Monitor, Plus, Smartphone, Wand2 } from 'lucide-react';
import type { AuditSection, WebPageSnapshot } from '../../../lib/types';
import { parseWebSectionDetail, findingHighlights, findingVisual } from '../../../lib/web-report-details';
import { fetchSectionAfterImages, generateSectionAfter } from '../../../lib/web-pipeline-status';
import { WEB_AFTER_IMAGES_ENABLED } from '../../../lib/feature-flags';
import { useReportEdit } from '../edit/ReportEditContext';
import EditablePlainText from '../edit/EditablePlainText';
import ImageLightbox from '../../ui/ImageLightbox';
import WebHighlightLayer from './WebHighlightLayer';
import { optimizedStorageImage } from '../../../lib/storage-image';
import WebFindingCard from './WebFindingCard';
import { LockedFindingsCard, lockedFindings } from './OutreachTeaser';

export default function WebPageSection({
  section,
  title,
  snapshots,
  hideTitle = false,
}: {
  section: AuditSection;
  title: string;
  snapshots: WebPageSnapshot[];
  /** The report frame already renders a numbered section heading; skip the
   * card's own so the title is not printed twice. */
  hideTitle?: boolean;
}) {
  const { editMode, updateSectionField, updateSectionDetailValue, flushSaves } = useReportEdit();
  const detail = useMemo(() => parseWebSectionDetail(section.section_details), [section.section_details]);
  // Default to mobile (most storefront traffic is mobile), falling back to
  // desktop only when there is no successful mobile shot.
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>(() =>
    snapshots.some((s) => s.viewport === 'mobile' && s.status === 'success' && s.screenshot_url) ? 'mobile' : 'desktop',
  );
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Which PIN the pointer is on, kept apart from activeIndex on purpose. Both
  // light up the matching finding, but only a pin fades the others: pointing at
  // the shot is asking "which one of these is that?", while running down the
  // list is just reading, and dimming it there would fight the reader.
  const [hoveredMarker, setHoveredMarker] = useState<number | null>(null);
  const [afterBusy, setAfterBusy] = useState(false);
  const [afterError, setAfterError] = useState('');
  // Locally overrides the persisted after image right after a (re)generate, so
  // the new concept shows without a full report reload.
  const [afterOverride, setAfterOverride] = useState<{ desktop?: string; mobile?: string }>({});
  // Which engine produced the freshly generated image, for the editor-only badge.
  const [engineOverride, setEngineOverride] = useState<{ desktop?: string; mobile?: string }>({});
  const [markersOverride, setMarkersOverride] = useState<{
    desktop?: Array<{ index: number; x: number; y: number; w: number; h: number }>;
    mobile?: Array<{ index: number; x: number; y: number; w: number; h: number }>;
  }>({});

  // "After" images are generated ~1-2 min AFTER analysis completes (the report is
  // viewable before they finish). Poll briefly so they appear on their own without
  // a manual refresh. Stops once both viewports have one, or after ~3 minutes.
  useEffect(() => {
    if (!WEB_AFTER_IMAGES_ENABLED) return;
    const PAGE_KEYS = ['web_homepage', 'web_product_page', 'web_collection_page', 'web_cart'];
    if (!PAGE_KEYS.includes(section.section_key)) return;
    const d0 = parseWebSectionDetail(section.section_details).after_images;
    if (d0.desktop?.url && d0.mobile?.url) return; // already have both
    let tries = 0;
    let cancelled = false;
    const id = window.setInterval(async () => {
      tries += 1;
      let imgs: Awaited<ReturnType<typeof fetchSectionAfterImages>> = {};
      try {
        imgs = await fetchSectionAfterImages(section.id);
      } catch { /* transient, keep polling */ }
      if (cancelled) return;
      if (imgs.desktop || imgs.mobile) {
        setAfterOverride((prev) => ({ desktop: prev.desktop ?? imgs.desktop, mobile: prev.mobile ?? imgs.mobile }));
        setEngineOverride((prev) => ({
          desktop: prev.desktop ?? imgs.meta?.desktop?.engine,
          mobile: prev.mobile ?? imgs.meta?.mobile?.engine,
        }));
        setMarkersOverride((prev) => ({
          desktop: prev.desktop ?? imgs.meta?.desktop?.markers,
          mobile: prev.mobile ?? imgs.meta?.mobile?.markers,
        }));
      }
      const haveD = Boolean(imgs.desktop || d0.desktop?.url);
      const haveM = Boolean(imgs.mobile || d0.mobile?.url);
      if ((haveD && haveM) || tries >= 18) window.clearInterval(id);
    }, 10000);
    return () => { cancelled = true; window.clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.id, section.section_key]);

  const successful = snapshots.filter((s) => s.status === 'success' && s.screenshot_url);
  const byId = new Map(successful.map((s) => [s.id, s]));

  // Warm BOTH viewports' screenshots up front. Only the selected one is in the
  // DOM, so switching to desktop used to start its download on click and leave
  // the mobile shot on screen for a second or two, which read as the toggle
  // being broken. Decoding too, not just fetching, so the swap is a paint and
  // not a decode. Joined URLs as the dep: the filtered array is a new identity
  // every render and would re-run this forever.
  const preloadKey = successful.map((s) => s.screenshot_url).join('|');
  useEffect(() => {
    if (typeof window === 'undefined' || !preloadKey) return;
    for (const url of preloadKey.split('|')) {
      if (!url) continue;
      const img = new Image();
      // Warm the SAME resized URL the layer renders, or this would download the
      // multi-megabyte original alongside the ~150KB version actually shown.
      img.src = optimizedStorageImage(url);
      void img.decode?.().catch(() => {});
    }
  }, [preloadKey]);

  // Show the viewport (above-the-fold) shot: it is what the AI annotated, so the
  // marker %-coordinates line up with it. Full-page shots use different heights,
  // so their coords would not map; those open in the lightbox for full context.
  const shown =
    successful.find((s) => s.viewport === viewport && s.variant === 'viewport') ??
    successful.find((s) => s.viewport === viewport && s.variant === 'full') ??
    byId.get(detail.primary_snapshot_id ?? '') ??
    successful[0] ??
    null;
  const fullForLightbox =
    successful.find((s) => s.viewport === viewport && s.variant === 'full') ?? shown;

  const hasDesktop = successful.some((s) => s.viewport === 'desktop');
  const hasMobile = successful.some((s) => s.viewport === 'mobile');

  // Show only the findings for the selected viewport (plus ones tagged 'both'),
  // then number them so the list and the pins on the shot agree. origIndex
  // tracks the real position in detail.findings for edits.
  //
  // Findings that can be pinned come first, then everything else, and only then
  // are they numbered. That keeps the markers on the screenshot running 1, 2, 3
  // with no gaps, while every finding still carries a number to refer to on a
  // call.
  //
  // The gap was real: the popup finding cannot be pinned, because the capture
  // strips popups before taking the shot, so there is nothing on the image to
  // point at. It was numbered 2 and the screenshot jumped from 1 to 3, sending
  // the reader hunting for a marker that was never going to be there.
  const pinnedOnShownShot = (finding: (typeof detail.findings)[number]) =>
    Boolean(shown && findingHighlights(finding).some((h) => h.snapshot_id === shown.id));

  const forViewport = detail.findings
    .map((f, origIndex) => ({ f, origIndex }))
    .filter(({ f }) => !f.removed)
    .filter(({ f }) => editMode || !f.hidden)
    .filter(({ f }) => f.viewport === 'both' || f.viewport === viewport)
    .map((item) => ({ ...item, pinned: pinnedOnShownShot(item.f) && !item.f.hidden }));

  // Stable within each group, so the order the audit chose still holds among the
  // pinned findings and among the rest.
  const visibleFindings = [
    ...forViewport.filter((item) => item.pinned),
    ...forViewport.filter((item) => !item.pinned),
  ].map((item, idx) => ({ ...item, number: idx + 1 }));

  // Findings that bring their own pictures (a "today" crop, a mock-up of the
  // fix) read as one row each, picture beside text, the way Hugo laid out the
  // Simple & Dainty v2. Showing the page screenshot as well put two screenshots
  // side by side and made the section a mishmash, so it steps aside.
  const rowsMode = visibleFindings.length > 0 && visibleFindings.every(({ f }) => Boolean(findingVisual(f, viewport)));

  // A finding can carry a pin per screenshot (desktop AND mobile); show the one
  // that belongs to the currently shown shot so the same finding pins on both.
  const markers = visibleFindings.flatMap(({ f, number }) => {
    if (!shown || f.hidden) return [];
    const hl = findingHighlights(f).find((h) => h.snapshot_id === shown.id);
    return hl ? [{ index: number, highlight: hl, text: f.text, recommendation: f.recommendation }] : [];
  });

  const setFinding = (i: number, key: string, value: unknown) => {
    const next = detail.findings.map((f, idx) => (idx === i ? { ...f, [key]: value } : f));
    updateSectionDetailValue(section.section_key, ['web', 'findings'], next);
  };
  const removeFindingHighlight = (i: number) => {
    const next = detail.findings.map((f, idx) => (idx === i ? { ...f, highlight: null, highlights: [] } : f));
    updateSectionDetailValue(section.section_key, ['web', 'findings'], next);
  };
  // Set aside rather than deleted. This used to filter the finding out of the
  // array, so a mis-click destroyed it with nothing to undo.
  const removeFinding = (i: number) => {
    const next = detail.findings.map((f, idx) => (idx === i ? { ...f, removed: true } : f));
    updateSectionDetailValue(section.section_key, ['web', 'findings'], next);
  };
  const restoreFinding = (i: number) => {
    const next = detail.findings.map((f, idx) => (idx === i ? { ...f, removed: false } : f));
    updateSectionDetailValue(section.section_key, ['web', 'findings'], next);
  };
  // Everything taken out of this section, in the order it was written, so the
  // drawer below can offer it back.
  const removedFindings = detail.findings
    .map((f, origIndex) => ({ f, origIndex }))
    .filter(({ f }) => f.removed);

  const addFinding = () => {
    const next = [...detail.findings, { text: '', recommendation: '', viewport, highlight: null, hidden: false }];
    updateSectionDetailValue(section.section_key, ['web', 'findings'], next);
  };
  // Anchor ids must be unique per section: every section numbers its findings
  // from 1, so a bare `finding-1` would collide across sections and always jump
  // to the first one (the homepage). Scope by section key.
  const findingAnchorId = (number: number) => `finding-${section.section_key}-${number}`;

  const focusFinding = (index: number) => {
    setActiveIndex(index);
    if (typeof document !== 'undefined') {
      document.getElementById(findingAnchorId(index))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  // With concept images off this stays null, which collapses the whole After
  // column, its control and its withheld notes to the Before shot alone. The
  // stored image is untouched and returns when the flag flips back.
  const afterUrl = WEB_AFTER_IMAGES_ENABLED
    ? afterOverride[viewport] ?? detail.after_images[viewport]?.url ?? null
    : null;
  const afterMeta = WEB_AFTER_IMAGES_ENABLED ? detail.after_images[viewport] : undefined;
  const afterEngine = engineOverride[viewport] ?? afterMeta?.engine ?? null;
  // Numbered pins on the After, carrying the same numbers as the Before pins so
  // "what changed" is visible at a glance instead of a spot-the-difference. The
  // freshly regenerated markers (override) win over the persisted ones.
  const afterMarkers = (markersOverride[viewport] ?? afterMeta?.markers ?? []).flatMap((m) => {
    const found = visibleFindings.find(({ number }) => number === m.index);
    return [{
      index: m.index,
      highlight: { snapshot_id: '', x: m.x, y: m.y, w: m.w, h: m.h, label: 'Applied change' },
      text: found?.f.text,
      recommendation: found?.f.recommendation,
    }];
  });
  // Both Before and After are always shown together when an after exists: mobile
  // side-by-side (narrow shots), desktop stacked (before above, after below). No
  // toggle needed.
  const twoUp = viewport === 'mobile';

  const generateAfter = async () => {
    setAfterBusy(true);
    setAfterError('');
    try {
      // The server reads this section's SAVED findings, so make sure any edit
      // still sitting in the 800ms debounce is written first. Otherwise a manual
      // tweak made moments ago would be missing from the concept image.
      await flushSaves();
      const res = await generateSectionAfter(section.audit_id, section.section_key, viewport);
      setAfterOverride((prev) => ({ ...prev, [res.viewport]: res.url }));
      // Read back which engine served it, so the badge is right without a reload.
      try {
        const fresh = await fetchSectionAfterImages(section.id);
        setEngineOverride((prev) => ({ ...prev, [res.viewport]: fresh.meta?.[res.viewport]?.engine }));
        setMarkersOverride((prev) => ({ ...prev, [res.viewport]: fresh.meta?.[res.viewport]?.markers ?? [] }));
      } catch { /* the badge just stays as it was */ }
      if (res.viewport !== viewport) setViewport(res.viewport);
    } catch (e) {
      setAfterError(e instanceof Error ? e.message : 'Could not generate the after image.');
    } finally {
      setAfterBusy(false);
    }
  };

  return (
    <section className="rounded-2xl bg-white p-6 card-shadow sm:p-7">
      {!hideTitle && <h2 className="text-lg font-semibold text-gray-900">{title}</h2>}
      {(editMode || section.summary_text) && (
        <div className="mt-1.5 text-sm leading-relaxed text-gray-600">
          <EditablePlainText
            value={section.summary_text ?? ''}
            onSave={(v) => updateSectionField(section.section_key, 'summary_text', v)}
            placeholder="Section summary…"
          />
        </div>
      )}

      {/* Viewport toggle (mobile first, it is the default and most storefront traffic) */}
      {shown && (hasDesktop || hasMobile) && (
        <div className="mt-4 flex items-center justify-end gap-1">
          {hasMobile && (
            <button
              type="button"
              onClick={() => setViewport('mobile')}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${viewport === 'mobile' ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-100'}`}
            >
              <Smartphone className="h-3.5 w-3.5" /> Mobile
            </button>
          )}
          {hasDesktop && (
            <button
              type="button"
              onClick={() => setViewport('desktop')}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${viewport === 'desktop' ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-100'}`}
            >
              <Monitor className="h-3.5 w-3.5" /> Desktop
            </button>
          )}
        </div>
      )}

      {/* Side-by-side: the annotated screenshot sits on the left (sticky while the
          reader scans), with every finding always expanded in a column on the
          right. The numbered pins on the shot match the numbered findings. */}
      <div className={`mt-5 grid grid-cols-1 items-start gap-6 ${rowsMode ? '' : 'lg:grid-cols-2'}`}>
        {/* Left: reference screenshot (before) with optional AI "after" concept */}
        {/* Clears the report's sticky section nav, which is ~46px tall and would
            otherwise crop the top of the pinned screenshot as you scroll. Same
            72px the anchor links already scroll to. */}
        <div className={rowsMode ? 'hidden' : 'lg:sticky lg:top-[4.5rem]'}>
          {shown ? (
            <div className={afterUrl || viewport === 'desktop' ? 'w-full' : 'mx-auto w-full max-w-[360px]'}>
              {/* Editor-only generate / regenerate control. */}
              {editMode && WEB_AFTER_IMAGES_ENABLED && (
                <div className="mb-2 flex items-center justify-end">
                  <button
                    type="button"
                    onClick={generateAfter}
                    disabled={afterBusy}
                    className="inline-flex items-center gap-1.5 rounded-md border border-brand-primary/30 bg-brand-primary/5 px-2.5 py-1 text-xs font-semibold text-brand-primary hover:bg-brand-primary/10 disabled:opacity-50"
                  >
                    {afterBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                    {afterBusy ? 'Generating…' : afterUrl ? 'Regenerate after' : 'Generate after'}
                  </button>
                </div>
              )}

              {afterUrl ? (
                // Show Before and After together: mobile side-by-side (narrow shots),
                // desktop stacked (Before above, After below) so both are visible
                // without a toggle.
                // items-stretch + a flex-1 image area makes both columns the same
                // height: the image model returns its own aspect ratio, so the
                // After is scaled to the Before's height (contained, never cropped)
                // instead of ending up visibly shorter beside it.
                <div className={twoUp ? 'grid grid-cols-2 items-stretch gap-3' : 'space-y-4'}>
                  {/* Before (with the numbered pins) */}
                  <div className="flex flex-col">
                    <p className="mb-1 text-center text-[11px] font-semibold uppercase tracking-wide text-gray-500">Before</p>
                    <div
                      className="cursor-zoom-in rounded-lg"
                      onClick={() => setLightbox(fullForLightbox?.screenshot_url ?? shown.screenshot_url)}
                    >
                      <WebHighlightLayer
                        imageUrl={shown.screenshot_url as string}
                        alt={`${title} (before)`}
                        markers={markers}
                        activeIndex={activeIndex ?? hoveredMarker}
                        onMarkerClick={focusFinding}
                        onMarkerHover={setHoveredMarker}
                      />
                    </div>
                  </div>
                  {/* After (AI concept) */}
                  <div className="flex min-h-0 flex-col">
                    <div className="mb-1 flex items-center justify-center gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-brand-primary">After</p>
                      {/* Editor-only, never shown to a client: which engine built
                          this image, so what is being judged is unambiguous. */}
                      {editMode && afterEngine && (
                        <span
                          title={afterEngine === 'html'
                            ? 'Built by editing the real page: the photos, fonts and colours are the store own assets, so nothing was repainted.'
                            : 'Built by the image model as a fallback, because the page could not be edited directly. Check the photos.'}
                          className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                            afterEngine === 'html'
                              ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                              : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                          }`}
                        >
                          {afterEngine === 'html' ? 'Real page' : 'Image model'}
                        </span>
                      )}
                      {editMode && afterMeta?.total_count != null && afterMeta.applied_count != null && (
                        <span className="text-[9px] font-medium uppercase tracking-wide text-gray-400">
                          {afterMeta.applied_count}/{afterMeta.total_count} fixes
                        </span>
                      )}
                    </div>
                    {afterMarkers.length > 0 ? (
                      // No overflow-hidden here: it would clip edge pins and
                      // their hover tooltips, same as on the Before.
                      <div
                        className="cursor-zoom-in rounded-lg border border-brand-primary/30"
                        onClick={() => setLightbox(afterUrl)}
                      >
                        <WebHighlightLayer
                          imageUrl={afterUrl}
                          alt={`${title} redesign concept`}
                          markers={afterMarkers}
                          activeIndex={activeIndex ?? hoveredMarker}
                          onMarkerClick={focusFinding}
                          onMarkerHover={setHoveredMarker}
                        />
                      </div>
                    ) : (
                      <div
                        className={`cursor-zoom-in overflow-hidden rounded-lg border border-brand-primary/30 ${twoUp ? 'min-h-0 flex-1' : ''}`}
                        onClick={() => setLightbox(afterUrl)}
                      >
                        <img
                          src={afterUrl}
                          alt={`${title} redesign concept`}
                          className={twoUp ? 'block h-full w-full object-contain object-top' : 'block w-full'}
                        />
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                // No overflow clip here so the pin hover tooltips can extend past
                // the screenshot edges.
                <div
                  className="cursor-zoom-in rounded-lg"
                  onClick={() => setLightbox(fullForLightbox?.screenshot_url ?? shown.screenshot_url)}
                >
                  <WebHighlightLayer
                    imageUrl={shown.screenshot_url as string}
                    alt={`${title} (${viewport})`}
                    markers={markers}
                    activeIndex={activeIndex ?? hoveredMarker}
                    onMarkerClick={focusFinding}
                    onMarkerHover={setHoveredMarker}
                  />
                </div>
              )}
              {/* A withheld After used to render as the Before alone with no
                  explanation, which reads as a broken report rather than a
                  deliberate refusal. Editors get the reason and the retry;
                  the client-facing view stays quiet. */}
              {editMode && !afterUrl && afterMeta?.error === 'photo_integrity_failed' && (
                <p className="mt-1.5 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                  Concept image withheld: the image model altered the client's own photos on every attempt, so nothing was published. Regenerate to try again.
                </p>
              )}
              {editMode && !afterUrl && afterMeta?.error === 'critical_layout_failed' && (
                <p className="mt-1.5 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                  Concept image withheld: the redesign broke something the page needs, such as text drawn over other text, an invented price, or a checkout button pushed out of view. Regenerate to try again.
                </p>
              )}
              {afterError && <p className="mt-1.5 rounded-lg bg-red-50 px-3 py-2 text-[11px] text-red-600">{afterError}</p>}
            </div>
          ) : (
            <div className="flex aspect-[16/10] items-center justify-center rounded-lg border border-dashed border-gray-200 bg-gray-50 text-xs text-gray-400">
              No screenshot captured
            </div>
          )}
        </div>

        {/* Right: findings, always expanded */}
        <div>
          {!rowsMode && <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Findings</p>}
          {visibleFindings.length === 0 && !editMode ? (
            <p className="mt-2 text-sm text-gray-400">No issues flagged on this page.</p>
          ) : (
            <div className={rowsMode ? 'space-y-4' : 'mt-2 space-y-3'}>
              {visibleFindings.map(({ f, number, origIndex, pinned }) => {
                const i = origIndex;
                return (
                  <WebFindingCard
                    key={i}
                    anchorId={findingAnchorId(number)}
                    number={number}
                    pinned={pinned}
                    finding={f}
                    viewport={viewport}
                    layout={rowsMode ? 'row' : 'stack'}
                    cropShot={null}
                    active={activeIndex === number || hoveredMarker === number}
                    dimmed={hoveredMarker !== null && hoveredMarker !== number}
                    onActivate={(a) => setActiveIndex(a ? number : null)}
                    onChangeText={(v) => setFinding(i, 'text', v)}
                    onChangeTitle={(v) => setFinding(i, 'title', v)}
                    onChangeRecommendation={(v) => setFinding(i, 'recommendation', v)}
                    onRemove={() => removeFinding(i)}
                    onRemoveHighlight={() => removeFindingHighlight(i)}
                    onToggleHidden={() => setFinding(i, 'hidden', !f.hidden)}
                  />
                );
              })}
            </div>
          )}
          {/* An outreach audit's public teaser: how many more this page holds back. */}
          {!editMode && <LockedFindingsCard count={lockedFindings(section)?.[viewport] ?? 0} />}
          {editMode && (
            <button
              type="button"
              onClick={addFinding}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-xs font-medium text-gray-500 hover:border-brand-primary/40 hover:text-brand-primary"
            >
              <Plus className="h-3.5 w-3.5" /> Add finding
            </button>
          )}

          {editMode && removedFindings.length > 0 && (
            <details className="mt-4 rounded-lg border border-gray-200 bg-gray-50/60">
              <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-gray-500 [&::-webkit-details-marker]:hidden">
                Removed from this section ({removedFindings.length})
                <span className="ml-1.5 font-normal text-gray-400">not shown in the report</span>
              </summary>
              <div className="space-y-2 border-t border-gray-200 px-3 py-2.5">
                {removedFindings.map(({ f, origIndex }) => (
                  <div key={origIndex} className="flex items-start gap-2">
                    <p className="min-w-0 flex-1 text-xs leading-snug text-gray-500">
                      {f.text || <span className="italic text-gray-400">Empty finding</span>}
                    </p>
                    <button
                      type="button"
                      onClick={() => restoreFinding(origIndex)}
                      className="shrink-0 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-600 hover:border-brand-primary/40 hover:text-brand-primary"
                    >
                      Put back
                    </button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>

      {lightbox && <ImageLightbox src={lightbox} alt={title} onClose={() => setLightbox(null)} />}
    </section>
  );
}
