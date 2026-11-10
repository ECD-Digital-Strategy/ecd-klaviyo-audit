import { supabase } from './supabase';
import { WEB_AFTER_IMAGES_ENABLED } from './feature-flags';

/** One label per step of web_finalize_analysis (order must match STEPS there). */
export const WEB_STEP_LABELS = [
  'Analyzing homepage',
  'Analyzing product page',
  'Analyzing collection page',
  'Analyzing cart',
  'Reviewing store data',
  'Writing the overview',
  'Building the roadmap',
] as const;

/** Labels shown in the progress UI: the analysis steps, plus the "after" concept
 * image generation when that is switched on. With concept images off the
 * roadmap is the last step, so the report is revealed as soon as analysis ends
 * instead of waiting on a phase that never runs. */
export const WEB_DISPLAY_STEP_LABELS: readonly string[] = WEB_AFTER_IMAGES_ENABLED
  ? [...WEB_STEP_LABELS, 'Generating concept images']
  : [...WEB_STEP_LABELS];

/** The capture phase, which runs in the browser before the server-side analysis
 * job exists. Shown as the first steps of the same checklist so a web audit has
 * ONE progress screen from start to finish instead of two. */
export const WEB_CAPTURE_STEP_LABELS = [
  'Fetching store data',
  'Detecting key pages',
  'Capturing screenshots (desktop and mobile)',
] as const;

/** Every step of a web audit, capture then analysis (then concept images, when
 * those are switched on). */
export const WEB_ALL_STEP_LABELS: readonly string[] = [
  ...WEB_CAPTURE_STEP_LABELS,
  ...WEB_DISPLAY_STEP_LABELS,
];

export const WEB_CAPTURE_STEP_COUNT = WEB_CAPTURE_STEP_LABELS.length;

/** Map a capture-phase stage message from runWebAudit onto its checklist index.
 * Returns WEB_CAPTURE_STEP_COUNT once capture is finished and the analysis job is
 * taking over. */
export function webCaptureStepFromStage(stage: string): number {
  const s = (stage || '').toLowerCase();
  if (/starting ai analysis|^done$/.test(s)) return WEB_CAPTURE_STEP_COUNT;
  if (/capturing/.test(s)) return 2;
  if (/detecting key pages/.test(s)) return 1;
  return 0; // "Starting…" and the Shopify/store data fetch
}

const TOTAL_ANALYSIS_STEPS = WEB_STEP_LABELS.length;
// Analysis steps, plus the after-image generation step when it is switched on.
const TOTAL_STEPS = TOTAL_ANALYSIS_STEPS + (WEB_AFTER_IMAGES_ENABLED ? 1 : 0);
const AFTERS_STEP_INDEX = TOTAL_ANALYSIS_STEPS;

export type WebPipelinePhase = 'capture' | 'analysis' | 'afters';

export type WebPipelineStatus = {
  exists: boolean;
  isGenerating: boolean;
  failed: boolean;
  /** True only when BOTH the analysis and the after images are done. */
  complete: boolean;
  error: string | null;
  stepIndex: number;
  progress: number;
  label: string;
  phase: WebPipelinePhase;
  /** A capture that was started but has gone quiet, because the tab driving it
   * was closed or refreshed. Re-running resumes from the shots it already got. */
  stalled?: boolean;
  captured?: { done: number; total: number };
};

/** The capture loop runs in the browser, so "is it still going?" can only be
 * answered by whether rows are still being touched. Captures land about once a
 * minute, so a gap this long means the tab driving it is gone. */
const CAPTURE_STALE_MS = 4 * 60 * 1000;

/** Capture progress straight from the snapshot rows, which is the only record of
 * this phase that survives a page reload. */
async function fetchCaptureProgress(auditId: string): Promise<
  { total: number; done: number; lastTouchedMs: number | null } | null
> {
  const { data } = await supabase
    .from('web_page_snapshots')
    .select('status, fetched_at')
    .eq('audit_id', auditId);
  const rows = data ?? [];
  if (rows.length === 0) return null;
  // The server writes 'error' for a shot that gave up; 'failed' is kept for any
  // older rows.
  const done = rows.filter(r => r.status === 'success' || r.status === 'error' || r.status === 'failed').length;
  const times = rows
    .map(r => (r.fetched_at ? new Date(r.fetched_at).getTime() : 0))
    .filter(t => t > 0);
  return {
    total: rows.length,
    done,
    lastTouchedMs: times.length > 0 ? Math.max(...times) : null,
  };
}

export async function fetchWebAuditPipelineStatus(auditId: string): Promise<WebPipelineStatus> {
  const [{ data }, { data: auditRow }] = await Promise.all([
    supabase
      .from('audit_analysis_jobs')
      .select('status, step_index, error_message')
      .eq('audit_id', auditId)
      .maybeSingle(),
    supabase
      .from('audits')
      .select('web_afters_ready')
      .eq('id', auditId)
      .maybeSingle(),
  ]);

  if (!data) {
    // No analysis job yet. That is either a run that never started, or one still
    // in the capture phase, which has no server-side job of its own. Snapshot
    // rows are the only trace capture leaves, so read progress from them.
    const capture = await fetchCaptureProgress(auditId);
    if (capture && capture.done < capture.total) {
      const quietFor = capture.lastTouchedMs ? Date.now() - capture.lastTouchedMs : Infinity;
      const stalled = quietFor > CAPTURE_STALE_MS;
      return {
        exists: true,
        isGenerating: !stalled,
        failed: false,
        complete: false,
        error: null,
        stepIndex: 2,
        progress: Math.round((capture.done / Math.max(capture.total, 1)) * 30),
        label: `${WEB_CAPTURE_STEP_LABELS[2]}, ${capture.done}/${capture.total} done`,
        phase: 'capture',
        stalled,
        captured: { done: capture.done, total: capture.total },
      };
    }
    return { exists: false, isGenerating: false, failed: false, complete: false, error: null, stepIndex: 0, progress: 0, label: '', phase: 'analysis' };
  }

  const failed = data.status === 'failed';
  const analysisComplete = data.status === 'complete';
  // Afters are "pending" only after analysis finished and the flag was flipped.
  // With concept images off there is no afters phase at all, and an old audit
  // still carrying web_afters_ready = false must not be held behind one.
  const aftersReady = !WEB_AFTER_IMAGES_ENABLED || auditRow?.web_afters_ready !== false;
  const inAftersPhase = analysisComplete && !aftersReady;
  const phase: WebPipelinePhase = inAftersPhase ? 'afters' : 'analysis';

  const complete = analysisComplete && aftersReady;
  const isGenerating = data.status === 'pending' || data.status === 'running' || inAftersPhase;

  // displayStepIndex spans 0..TOTAL_STEPS: analysis steps, then the afters step.
  const stepIndex = complete
    ? TOTAL_STEPS
    : inAftersPhase
      ? AFTERS_STEP_INDEX
      : Math.max(0, Math.min(TOTAL_ANALYSIS_STEPS, Number(data.step_index) || 0));

  const progress = complete ? 100 : Math.round((stepIndex / TOTAL_STEPS) * 100);
  const label = complete
    ? 'Done'
    : failed
      ? 'Analysis failed'
      : `${WEB_DISPLAY_STEP_LABELS[Math.min(stepIndex, TOTAL_STEPS - 1)]}…`;
  return { exists: true, isGenerating, failed, complete, error: data.error_message ?? null, stepIndex, progress, label, phase };
}

/** Re-kick the auto "after" image generation chain (idempotent: it skips any
 * viewport that already has an image). Used to nudge a stalled afters phase. */
export async function kickAfterGeneration(auditId: string): Promise<void> {
  if (!WEB_AFTER_IMAGES_ENABLED) return;
  try {
    await supabase.functions.invoke('web_generate_after', {
      body: { audit_id: auditId, mode: 'auto' },
    });
  } catch {
    // best effort; the poller will try again
  }
}

/** Generate (or regenerate) the AI "after" concept image for one page section.
 *  Returns the new image URL (and the viewport it was made for), or throws with
 *  a readable message the report can surface. Image editing can take a while, so
 *  no client timeout: the caller shows its own spinner. */
export async function generateSectionAfter(
  auditId: string,
  sectionKey: string,
  viewport?: 'desktop' | 'mobile',
): Promise<{ url: string; viewport: 'desktop' | 'mobile' }> {
  // Last line of defence: the UI hides every entry point while afters are off,
  // so reaching here means a caller was missed. Fail loudly and locally rather
  // than round-tripping to a function that will refuse anyway.
  if (!WEB_AFTER_IMAGES_ENABLED) {
    throw new Error('Concept images are turned off for web audits.');
  }
  const { data, error } = await supabase.functions.invoke('web_generate_after', {
    body: { audit_id: auditId, section_key: sectionKey, ...(viewport ? { viewport } : {}) },
  });
  if (error) throw new Error(error.message || 'Failed to generate the after image');
  const res = data as { ok?: boolean; url?: string; viewport?: string; error?: { message?: string } };
  if (!res?.ok || !res.url) throw new Error(res?.error?.message || 'Could not generate the after image.');
  return { url: res.url, viewport: res.viewport === 'mobile' ? 'mobile' : 'desktop' };
}

/** Fetch just the current after-image URLs for a section (used to poll the
 * report so auto-generated afters appear without a manual refresh). */
export type AfterImageMeta = {
  url: string;
  engine?: string;
  applied_count?: number;
  total_count?: number;
  markers?: Array<{ index: number; x: number; y: number; w: number; h: number }>;
};

export async function fetchSectionAfterImages(
  sectionId: string,
): Promise<{ desktop?: string; mobile?: string; meta?: { desktop?: AfterImageMeta; mobile?: AfterImageMeta } }> {
  const { data } = await supabase
    .from('audit_sections')
    .select('section_details')
    .eq('id', sectionId)
    .maybeSingle();
  const web = ((data?.section_details as Record<string, unknown> | null | undefined)?.web ?? {}) as Record<string, unknown>;
  const ai = (web.after_images ?? {}) as Record<string, AfterImageMeta | undefined>;
  const out: { desktop?: string; mobile?: string; meta?: { desktop?: AfterImageMeta; mobile?: AfterImageMeta } } = {};
  const meta: { desktop?: AfterImageMeta; mobile?: AfterImageMeta } = {};
  if (ai.desktop?.url) { out.desktop = ai.desktop.url; meta.desktop = ai.desktop; }
  if (ai.mobile?.url) { out.mobile = ai.mobile.url; meta.mobile = ai.mobile; }
  out.meta = meta;
  return out;
}

/** Kick the web analysis edge function. Races an 8s timeout so a slow first
 *  step doesn't block the caller; the job keeps running server-side. */
export async function startWebAnalysis(auditId: string, mode?: 'regenerate'): Promise<void> {
  const invokePromise = supabase.functions.invoke('web_finalize_analysis', {
    body: { audit_id: auditId, ...(mode ? { mode } : {}) },
  });
  const result = await Promise.race([
    invokePromise,
    new Promise<{ data: null; error: null }>((resolve) => window.setTimeout(() => resolve({ data: null, error: null }), 8_000)),
  ]);
  const err = (result as { error?: { message?: string; context?: { status?: number } } }).error;
  if (err) {
    const status = err.context?.status;
    if (Number(status) === 546 || Number(status) === 504) return;
    throw new Error(err.message || 'Failed to start web analysis');
  }
}
