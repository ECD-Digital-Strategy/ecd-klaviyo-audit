import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Audit, AuditSection } from '../../../lib/types';
import { updateAudit, updateAuditSection } from '../../../lib/db';
import { scheduleSavedToast, useToast } from '../../ui/Toast';
import type { RevenueOpportunityAddOnItem } from '../../../lib/types';
import type { AuditSectionKey } from '../../../lib/addon-highlight';
import { computeAuditTotalRevenueOpportunity } from '../../../lib/revenue-calculator';
import { normalizeCoreFlowsMatrix, sanitizeStructureNote, type CoreFlowRow } from '../../../lib/core-flows-matrix';
import {
  materializeSectionKeyFindingsHidden,
  normalizeWorkspaceSectionKeyFindings,
  parseSectionKeyFindings,
  serializeSectionKeyFindings,
} from '../../../lib/section-key-findings';
// Executive-summary findings (plain string arrays), NOT the per-section
// key-findings above, which take a SectionKeyFindings object instead.
import { getExecutiveFindingsForEdit, normalizeWorkspaceKeyFindings } from '../../../lib/findings-normalize';
import type { SectionKeyFindings } from '../../../lib/types';
import { repairEntityMarkers } from '../../../lib/entity-tags';
import { normalizeImageScale } from '../../../lib/report-image-scale';
import { writeFlowsConfigPatch, writeGenericConfigPatch, writeGenericBlockPatch, writeFlowsBlockPatch, writeExecutiveBlockPatch, writeRevenueBlockPatch } from '../../../lib/report-config/section-hide';

type LayoutSectionKey = 'executive_summary' | 'revenue_summary' | 'deliverability_snapshot' | 'attribution_model';
type LayoutKeyFindingsKey = 'deliverability_snapshot' | 'attribution_model';

const LAYOUT_KEY_FINDINGS_KEYS = new Set<string>(['deliverability_snapshot', 'attribution_model']);

function isLayoutKeyFindingsKey(key: string): key is LayoutKeyFindingsKey {
  return LAYOUT_KEY_FINDINGS_KEYS.has(key);
}

export type TimelinePhase = {
  phase: string;
  timeframe: string;
  label: string;
  items: string[];
};

export type ExecutivePayload = {
  text?: string;
  findings?: string[];
  concerns?: string[];
  strengths?: string[];
  findingsHidden?: boolean[];
  strengthsHidden?: boolean[];
  timelineHidden?: boolean[];
  timeline?: TimelinePhase[];
};

function parseExecutiveSummary(raw: string): ExecutivePayload {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ExecutivePayload;
    }
  } catch {
    /* plain text */
  }
  return { text: raw };
}

function materializeFindings(payload: ExecutivePayload): string[] {
  return normalizeWorkspaceKeyFindings(payload.findings, payload.concerns);
}

function materializeFindingsHidden(payload: ExecutivePayload, length: number): boolean[] {
  const hidden = [...(payload.findingsHidden ?? [])];
  while (hidden.length < length) hidden.push(false);
  return hidden.slice(0, length);
}

function serializeExecutive(payload: ExecutivePayload, fallbackRaw: string): string {
  if (
    payload.findings?.length ||
    payload.strengths?.length ||
    payload.findingsHidden?.some(Boolean) ||
    payload.strengthsHidden?.some(Boolean) ||
    payload.timelineHidden?.some(Boolean) ||
    payload.timeline?.length ||
    (payload.text && payload.text !== fallbackRaw)
  ) {
    return JSON.stringify(payload);
  }
  return payload.text ?? fallbackRaw;
}

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

type SaveResult = 'ok' | 'failed' | 'superseded';

type ReportEditContextValue = {
  editMode: boolean;
  /** Public / published report: allow Investment Summary line-item toggles without full edit chrome. */
  investmentToggleMode: boolean;
  saveStatus: SaveStatus;
  updateFinding: (index: number, value: string) => void;
  addFinding: () => void;
  removeFinding: (index: number) => void;
  updateStrength: (index: number, value: string) => void;
  updateExecText: (value: string) => void;
  updateSectionField: (
    sectionKey: string,
    field: 'current_state_notes' | 'optimized_notes' | 'current_state_title' | 'optimized_state_title' | 'human_edited_findings' | 'summary_text',
    value: string,
  ) => void;
  updateLayoutTitle: (
    layoutKey: LayoutSectionKey,
    field: 'sectionTitle' | 'sectionNumber',
    value: string,
  ) => void;
  updateBlockTitle: (
    layoutKey: 'executive_summary' | 'revenue_summary',
    blockKey: string,
    field: 'title' | 'subtitle',
    value: string,
  ) => void;
  updateTimelinePhase: (phaseIndex: number, field: keyof TimelinePhase, value: string | string[]) => void;
  updateTimelineItem: (phaseIndex: number, itemIndex: number, value: string) => void;
  updateAddOnField: (
    itemKey: string,
    field: 'name' | 'description' | 'details_url',
    value: string,
  ) => void;
  updateAddOnRevenue: (itemKey: string, value: number) => void;
  updateAddOnPrice: (
    itemKey: string,
    field: 'one_time_price' | 'one_time_label' | 'monthly_price' | 'monthly_label',
    value: number | string | null,
  ) => void;
  updateAddOnContent: (itemKey: string, value: string) => void;
  updateAddOnImage: (itemKey: string, value: string | null) => void;
  updateAddOnImageScale: (itemKey: string, scale: number) => void;
  setAddOnTalkTrackForSection: (itemKey: string, sectionKey: AuditSectionKey, enabled: boolean) => void;
  updateAddOnPresenterNote: (itemKey: string, note: string) => void;
  toggleAddOnInvestmentIncluded: (itemKey: string, included: boolean) => void;
  updateAttributionScreenshot: (value: string | null) => void;
  updateAttributionScreenshotScale: (scale: number) => void;
  updateSectionRevenueOpportunity: (sectionKey: string, value: number) => void;
  toggleLayoutSectionHidden: (layoutKey: LayoutSectionKey, hidden: boolean) => void;
  toggleAuditSectionHidden: (sectionKey: string, hidden: boolean) => void;
  toggleExecutiveBlockHidden: (blockKey: string, hidden: boolean) => void;
  toggleRevenueBlockHidden: (blockKey: string, hidden: boolean) => void;
  toggleSectionBlockHidden: (sectionKey: string, blockKey: string, hidden: boolean) => void;
  toggleFlowsBlockHidden: (blockKey: string, hidden: boolean) => void;
  toggleFindingHidden: (index: number, hidden: boolean) => void;
  toggleStrengthHidden: (index: number, hidden: boolean) => void;
  toggleTimelinePhaseHidden: (index: number, hidden: boolean) => void;
  updateSectionKeyFinding: (targetKey: string, index: number, value: string) => void;
  addSectionKeyFinding: (targetKey: string) => void;
  removeSectionKeyFinding: (targetKey: string, index: number) => void;
  toggleSectionKeyFindingHidden: (targetKey: string, index: number, hidden: boolean) => void;
  toggleSectionKeyFindingsBlockHidden: (targetKey: string, hidden: boolean) => void;
  updateLayoutBlockTitle: (
    layoutKey: LayoutKeyFindingsKey,
    blockKey: string,
    field: 'title' | 'subtitle',
    value: string,
  ) => void;
  updateSectionBlockField: (
    sectionKey: string,
    blockKey: string,
    field: 'title' | 'subtitle' | 'currentTitle' | 'optimizedTitle',
    value: string,
  ) => void;
  updateSectionDetailField: (sectionKey: string, path: string[], value: string) => void;
  updateSectionDetailValue: (sectionKey: string, path: string[], value: unknown) => void;
  updateCoreFlowMatrixNote: (
    sectionKey: string,
    rowIndex: number,
    field: 'current_structure_note' | 'recommended_structure',
    value: string,
  ) => void;
  patchSectionBlock: (sectionKey: string, blockKey: string, patch: Record<string, unknown>) => void;
  /** Write any debounced edits immediately. Await this before an action that
   * reads the saved report server-side (e.g. regenerating an "after" image from
   * the current findings), otherwise the 800ms debounce can still be pending and
   * the server would work from stale data. */
  flushSaves: () => Promise<void>;
};

const ReportEditContext = createContext<ReportEditContextValue>({
  editMode: false,
  addFinding: () => {},
  removeFinding: () => {},
  investmentToggleMode: false,
  saveStatus: 'idle',
  updateFinding: () => {},
  updateStrength: () => {},
  updateExecText: () => {},
  updateSectionField: () => {},
  updateLayoutTitle: () => {},
  updateBlockTitle: () => {},
  updateTimelinePhase: () => {},
  updateTimelineItem: () => {},
  updateAddOnField: () => {},
  updateAddOnRevenue: () => {},
  updateAddOnPrice: () => {},
  updateAddOnContent: () => {},
  updateAddOnImage: () => {},
  updateAddOnImageScale: () => {},
  setAddOnTalkTrackForSection: () => {},
  updateAddOnPresenterNote: () => {},
  toggleAddOnInvestmentIncluded: () => {},
  updateAttributionScreenshot: () => {},
  updateAttributionScreenshotScale: () => {},
  updateSectionRevenueOpportunity: () => {},
  toggleLayoutSectionHidden: () => {},
  toggleAuditSectionHidden: () => {},
  toggleExecutiveBlockHidden: () => {},
  toggleRevenueBlockHidden: () => {},
  toggleSectionBlockHidden: () => {},
  toggleFlowsBlockHidden: () => {},
  toggleFindingHidden: () => {},
  toggleStrengthHidden: () => {},
  toggleTimelinePhaseHidden: () => {},
  updateSectionKeyFinding: () => {},
  addSectionKeyFinding: () => {},
  removeSectionKeyFinding: () => {},
  toggleSectionKeyFindingHidden: () => {},
  toggleSectionKeyFindingsBlockHidden: () => {},
  updateLayoutBlockTitle: () => {},
  updateSectionBlockField: () => {},
  updateSectionDetailField: () => {},
  updateSectionDetailValue: () => {},
  updateCoreFlowMatrixNote: () => {},
  patchSectionBlock: () => {},
  flushSaves: async () => {},
});

export function useReportEdit() {
  return useContext(ReportEditContext);
}

export function ReportEditProvider({
  editMode,
  investmentToggleMode = false,
  audit,
  sections,
  onAuditChange,
  onSectionsChange,
  children,
}: {
  editMode: boolean;
  investmentToggleMode?: boolean;
  audit: Audit;
  sections: AuditSection[];
  onAuditChange: (next: Audit) => void;
  onSectionsChange: (next: AuditSection[]) => void;
  children: ReactNode;
}) {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const timers = useRef<Record<string, number>>({});
  // The debounced write for each key, kept so flushSaves() can run them early.
  // A failed write stays here (after one retry) until it or a newer edit lands.
  const pending = useRef<Record<string, () => Promise<void>>>({});
  // Writes currently running, so a flush waits for them instead of sending twice.
  const inFlight = useRef(new Map<() => Promise<void>, Promise<SaveResult>>());
  // Keys whose last write failed; the status stays "error" while any remain.
  const failed = useRef<Set<string>>(new Set());
  const toast = useToast();

  const settleStatus = useCallback((anyFailed: boolean, showToast: boolean) => {
    if (anyFailed || failed.current.size > 0) {
      setSaveStatus('error');
      if (anyFailed) toast('Could not save');
      return;
    }
    setSaveStatus('saved');
    if (showToast) scheduleSavedToast(toast);
    window.setTimeout(() => setSaveStatus(s => (s === 'saved' ? 'idle' : s)), 2500);
  }, [toast]);

  /** Run one write, retrying once. Only clears the pending entry it sent. */
  const runSave = useCallback((key: string, fn: () => Promise<void>): Promise<SaveResult> => {
    const running = inFlight.current.get(fn);
    if (running) return running;
    const run = (async (): Promise<SaveResult> => {
      for (let attempt = 0; attempt < 2; attempt++) {
        // A newer edit for this key replaced this write: don't resend stale data.
        if (attempt > 0 && pending.current[key] !== fn) return 'superseded';
        try {
          await fn();
          if (pending.current[key] === fn) delete pending.current[key];
          failed.current.delete(key);
          return 'ok';
        } catch {
          if (attempt === 0) await new Promise(resolve => window.setTimeout(resolve, 1500));
        }
      }
      failed.current.add(key);
      return 'failed';
    })();
    inFlight.current.set(fn, run);
    void run.finally(() => inFlight.current.delete(fn));
    return run;
  }, []);

  const schedule = useCallback((key: string, fn: () => Promise<void>) => {
    if (timers.current[key]) window.clearTimeout(timers.current[key]);
    setSaveStatus('saving');
    pending.current[key] = fn;
    timers.current[key] = window.setTimeout(async () => {
      delete timers.current[key];
      const result = await runSave(key, fn);
      if (result !== 'superseded') settleStatus(result === 'failed', true);
    }, 800) as unknown as number;
  }, [runSave, settleStatus]);

  /** Run every debounced write now instead of waiting out the timer. */
  const flushSaves = useCallback(async () => {
    const keys = Object.keys(pending.current);
    if (keys.length === 0 && inFlight.current.size === 0) return;
    for (const key of keys) {
      if (timers.current[key]) {
        window.clearTimeout(timers.current[key]);
        delete timers.current[key];
      }
    }
    setSaveStatus('saving');
    let anyFailed = false;
    // Sequential: several writes can target the same section row.
    for (const key of keys) {
      const fn = pending.current[key];
      if (!fn) continue;
      if ((await runSave(key, fn)) === 'failed') anyFailed = true;
    }
    // Wait for writes that were already running when the flush started.
    await Promise.all([...inFlight.current.values()]);
    settleStatus(anyFailed, false);
  }, [runSave, settleStatus]);

  // Closing or leaving the tab: send pending edits now and warn while any are unsaved.
  useEffect(() => {
    const hasUnsaved = () => Object.keys(pending.current).length > 0 || inFlight.current.size > 0;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsaved()) return;
      void flushSaves();
      event.preventDefault();
      event.returnValue = '';
    };
    const onPageHide = () => {
      if (Object.keys(pending.current).length > 0) void flushSaves();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
    };
  }, [flushSaves]);

  const getExecPayload = useCallback(
    () => parseExecutiveSummary(audit.executive_summary || ''),
    [audit.executive_summary],
  );

  const saveExecutive = useCallback(
    (patch: Partial<ExecutivePayload>) => {
      const prev = getExecPayload();
      const nextPayload = { ...prev, ...patch };
      const serialized = serializeExecutive(nextPayload, audit.executive_summary || '');
      onAuditChange({ ...audit, executive_summary: serialized });
      schedule('executive', async () => {
        await updateAudit(audit.id, { executive_summary: serialized });
      });
    },
    [audit, getExecPayload, onAuditChange, schedule],
  );

  const updateFinding = useCallback(
    (index: number, value: string) => {
      const prev = getExecPayload();
      const findings = materializeFindings(prev);
      while (findings.length <= index) findings.push('');
      findings[index] = repairEntityMarkers(value);
      saveExecutive({
        findings,
        findingsHidden: materializeFindingsHidden(prev, findings.length),
      });
    },
    [getExecPayload, saveExecutive],
  );

  const addFinding = useCallback(() => {
    const prev = getExecPayload();
    // Only trailing blanks are dropped, so hidden flags keep their positions.
    const findings = getExecutiveFindingsForEdit(prev.findings, prev.concerns);
    while (findings.length > 0 && !findings[findings.length - 1].trim()) findings.pop();
    findings.push('');
    const findingsHidden = materializeFindingsHidden(prev, findings.length);
    while (findingsHidden.length < findings.length) findingsHidden.push(false);
    saveExecutive({ findings, findingsHidden });
  }, [getExecPayload, saveExecutive]);

  const removeFinding = useCallback(
    (index: number) => {
      const prev = getExecPayload();
      let findings = materializeFindings(prev);
      let findingsHidden = materializeFindingsHidden(prev, findings.length);
      if (index < 0 || index >= findings.length) return;

      if (findings.length <= 1) {
        findings = [];
        findingsHidden = [];
      } else {
        findings = findings.filter((_, i) => i !== index);
        findingsHidden = findingsHidden.filter((_, i) => i !== index);
      }
      saveExecutive({ findings, findingsHidden });
    },
    [getExecPayload, saveExecutive],
  );

  const updateStrength = useCallback(
    (index: number, value: string) => {
      const prev = getExecPayload();
      const strengths = [...(prev.strengths ?? [])];
      while (strengths.length <= index) strengths.push('');
      strengths[index] = repairEntityMarkers(value);
      saveExecutive({ strengths });
    },
    [getExecPayload, saveExecutive],
  );

  const updateExecText = useCallback(
    (value: string) => saveExecutive({ text: value }),
    [saveExecutive],
  );

  const updateSectionField = useCallback(
    (
      sectionKey: string,
      field: 'current_state_notes' | 'optimized_notes' | 'current_state_title' | 'optimized_state_title' | 'human_edited_findings' | 'summary_text',
      value: string,
    ) => {
      const section = sections.find(s => s.section_key === sectionKey);
      if (!section) return;
      const nextSections = sections.map(s =>
        s.id === section.id ? { ...s, [field]: value } : s,
      );
      onSectionsChange(nextSections);
      schedule(`section-${section.id}-${field}`, async () => {
        await updateAuditSection(section.id, { [field]: value } as Partial<AuditSection>);
      });
    },
    [sections, onSectionsChange, schedule],
  );

  const patchLayout = useCallback(
    (layoutKey: LayoutSectionKey, patchFn: (section: Record<string, unknown>) => Record<string, unknown>) => {
      const layout = { ...((audit.layout as Record<string, unknown>) ?? {}) };
      const section = { ...((layout[layoutKey] as Record<string, unknown>) ?? {}) };
      layout[layoutKey] = patchFn(section);
      onAuditChange({ ...audit, layout });
      schedule(`layout-${layoutKey}`, async () => {
        await updateAudit(audit.id, { layout });
      });
    },
    [audit, onAuditChange, schedule],
  );

  const updateLayoutTitle = useCallback(
    (layoutKey: LayoutSectionKey, field: 'sectionTitle' | 'sectionNumber', value: string) => {
      patchLayout(layoutKey, section => ({ ...section, [field]: value || undefined }));
    },
    [patchLayout],
  );

  const updateBlockTitle = useCallback(
    (layoutKey: 'executive_summary' | 'revenue_summary', blockKey: string, field: 'title' | 'subtitle', value: string) => {
      patchLayout(layoutKey, section => {
        const blocks = { ...((section.blocks as Record<string, unknown>) ?? {}) };
        const block = { ...((blocks[blockKey] as Record<string, unknown>) ?? {}), [field]: value || undefined };
        blocks[blockKey] = block;
        return { ...section, blocks };
      });
    },
    [patchLayout],
  );

  const updateLayoutBlockTitle = useCallback(
    (layoutKey: LayoutKeyFindingsKey, blockKey: string, field: 'title' | 'subtitle', value: string) => {
      patchLayout(layoutKey, section => {
        const blocks = { ...((section.blocks as Record<string, unknown>) ?? {}) };
        const block = { ...((blocks[blockKey] as Record<string, unknown>) ?? {}), [field]: value || undefined };
        blocks[blockKey] = block;
        return { ...section, blocks };
      });
    },
    [patchLayout],
  );

  const getAuditSectionKeyFindings = useCallback(
    (sectionKey: string): SectionKeyFindings => {
      const section = sections.find(s => s.section_key === sectionKey);
      return parseSectionKeyFindings(section?.key_findings);
    },
    [sections],
  );

  const getLayoutKeyFindings = useCallback(
    (layoutKey: LayoutKeyFindingsKey): SectionKeyFindings => {
      const layout = (audit.layout as Record<string, unknown> | null | undefined) ?? {};
      const section = (layout[layoutKey] as Record<string, unknown> | null | undefined) ?? {};
      return parseSectionKeyFindings(section.key_findings);
    },
    [audit.layout],
  );

  const saveAuditSectionKeyFindings = useCallback(
    (sectionKey: string, keyFindings: SectionKeyFindings) => {
      const section = sections.find(s => s.section_key === sectionKey);
      if (!section) return;
      const nextSections = sections.map(s =>
        s.id === section.id ? { ...s, key_findings: keyFindings } : s,
      );
      onSectionsChange(nextSections);
      schedule(`section-kf-${section.id}`, async () => {
        await updateAuditSection(section.id, { key_findings: keyFindings });
      });
    },
    [sections, onSectionsChange, schedule],
  );

  const saveLayoutKeyFindings = useCallback(
    (layoutKey: LayoutKeyFindingsKey, keyFindings: SectionKeyFindings) => {
      patchLayout(layoutKey, section => ({ ...section, key_findings: keyFindings }));
    },
    [patchLayout],
  );

  const materializeKeyFindingsItems = useCallback(
    (targetKey: string): string[] => {
      if (isLayoutKeyFindingsKey(targetKey)) {
        const kf = getLayoutKeyFindings(targetKey);
        return normalizeWorkspaceSectionKeyFindings(kf);
      }
      const section = sections.find(s => s.section_key === targetKey);
      const kf = getAuditSectionKeyFindings(targetKey);
      const legacy = section?.human_edited_findings || section?.summary_text;
      return normalizeWorkspaceSectionKeyFindings(kf, legacy);
    },
    [getAuditSectionKeyFindings, getLayoutKeyFindings, sections],
  );

  const updateSectionKeyFinding = useCallback(
    (targetKey: string, index: number, value: string) => {
      const items = materializeKeyFindingsItems(targetKey);
      while (items.length <= index) items.push('');
      items[index] = repairEntityMarkers(value);
      const prev = isLayoutKeyFindingsKey(targetKey)
        ? getLayoutKeyFindings(targetKey)
        : getAuditSectionKeyFindings(targetKey);
      const next = serializeSectionKeyFindings(items, materializeSectionKeyFindingsHidden(prev, items.length));
      if (isLayoutKeyFindingsKey(targetKey)) saveLayoutKeyFindings(targetKey, next);
      else saveAuditSectionKeyFindings(targetKey, next);
    },
    [
      getAuditSectionKeyFindings,
      getLayoutKeyFindings,
      materializeKeyFindingsItems,
      saveAuditSectionKeyFindings,
      saveLayoutKeyFindings,
    ],
  );

  const addSectionKeyFinding = useCallback(
    (targetKey: string) => {
      // Only trailing blanks are dropped, so hidden flags keep their positions.
      const items = materializeKeyFindingsItems(targetKey);
      while (items.length > 0 && !items[items.length - 1].trim()) items.pop();
      items.push('');
      const prev = isLayoutKeyFindingsKey(targetKey)
        ? getLayoutKeyFindings(targetKey)
        : getAuditSectionKeyFindings(targetKey);
      const items_hidden = materializeSectionKeyFindingsHidden(prev, items.length);
      while (items_hidden.length < items.length) items_hidden.push(false);
      const next = serializeSectionKeyFindings(items, items_hidden);
      if (isLayoutKeyFindingsKey(targetKey)) saveLayoutKeyFindings(targetKey, next);
      else saveAuditSectionKeyFindings(targetKey, next);
    },
    [
      getAuditSectionKeyFindings,
      getLayoutKeyFindings,
      materializeKeyFindingsItems,
      saveAuditSectionKeyFindings,
      saveLayoutKeyFindings,
    ],
  );

  const removeSectionKeyFinding = useCallback(
    (targetKey: string, index: number) => {
      let items = materializeKeyFindingsItems(targetKey);
      let items_hidden = materializeSectionKeyFindingsHidden(
        isLayoutKeyFindingsKey(targetKey)
          ? getLayoutKeyFindings(targetKey)
          : getAuditSectionKeyFindings(targetKey),
        items.length,
      );
      if (index < 0 || index >= items.length) return;
      if (items.length <= 1) {
        items = [];
        items_hidden = [];
      } else {
        items = items.filter((_, i) => i !== index);
        items_hidden = items_hidden.filter((_, i) => i !== index);
      }
      const next = serializeSectionKeyFindings(items, items_hidden);
      if (isLayoutKeyFindingsKey(targetKey)) saveLayoutKeyFindings(targetKey, next);
      else saveAuditSectionKeyFindings(targetKey, next);
    },
    [
      getAuditSectionKeyFindings,
      getLayoutKeyFindings,
      materializeKeyFindingsItems,
      saveAuditSectionKeyFindings,
      saveLayoutKeyFindings,
    ],
  );

  const toggleSectionKeyFindingHidden = useCallback(
    (targetKey: string, index: number, hidden: boolean) => {
      const prev = isLayoutKeyFindingsKey(targetKey)
        ? getLayoutKeyFindings(targetKey)
        : getAuditSectionKeyFindings(targetKey);
      const items = materializeKeyFindingsItems(targetKey);
      const items_hidden = materializeSectionKeyFindingsHidden(prev, items.length);
      while (items_hidden.length <= index) items_hidden.push(false);
      items_hidden[index] = hidden;
      const next = serializeSectionKeyFindings(items, items_hidden);
      if (isLayoutKeyFindingsKey(targetKey)) saveLayoutKeyFindings(targetKey, next);
      else saveAuditSectionKeyFindings(targetKey, next);
    },
    [
      getAuditSectionKeyFindings,
      getLayoutKeyFindings,
      materializeKeyFindingsItems,
      saveAuditSectionKeyFindings,
      saveLayoutKeyFindings,
    ],
  );

  const updateTimelinePhase = useCallback(
    (phaseIndex: number, field: keyof TimelinePhase, value: string | string[]) => {
      const prev = getExecPayload();
      const timeline = [...(prev.timeline ?? [])];
      while (timeline.length <= phaseIndex) {
        timeline.push({ phase: '', timeframe: '', label: '', items: [] });
      }
      timeline[phaseIndex] = { ...timeline[phaseIndex], [field]: value };
      saveExecutive({ timeline });
    },
    [getExecPayload, saveExecutive],
  );

  const updateTimelineItem = useCallback(
    (phaseIndex: number, itemIndex: number, value: string) => {
      const prev = getExecPayload();
      const timeline = [...(prev.timeline ?? [])];
      const phase = timeline[phaseIndex];
      if (!phase) return;
      const items = [...(phase.items ?? [])];
      while (items.length <= itemIndex) items.push('');
      items[itemIndex] = repairEntityMarkers(value);
      timeline[phaseIndex] = { ...phase, items };
      saveExecutive({ timeline });
    },
    [getExecPayload, saveExecutive],
  );

  const syncAuditTotalRevenue = useCallback(
    (nextSections: AuditSection[], baseAudit: Audit) => {
      const total = computeAuditTotalRevenueOpportunity(nextSections, baseAudit.layout);
      if (total === baseAudit.total_revenue_opportunity) return baseAudit;
      const nextAudit = { ...baseAudit, total_revenue_opportunity: total };
      onAuditChange(nextAudit);
      schedule('audit-total-revenue', async () => {
        await updateAudit(baseAudit.id, { total_revenue_opportunity: total });
      });
      return nextAudit;
    },
    [onAuditChange, schedule],
  );

  const updateSectionRevenueOpportunity = useCallback(
    (sectionKey: string, value: number) => {
      const section = sections.find(s => s.section_key === sectionKey);
      if (!section) return;
      const nextSections = sections.map(s =>
        s.id === section.id ? { ...s, revenue_opportunity: value } : s,
      );
      onSectionsChange(nextSections);
      syncAuditTotalRevenue(nextSections, audit);
      schedule(`section-${section.id}-revenue_opportunity`, async () => {
        await updateAuditSection(section.id, { revenue_opportunity: value });
      });
    },
    [sections, onSectionsChange, syncAuditTotalRevenue, audit, schedule],
  );

  const updateAddOnField = useCallback(
    (itemKey: string, field: 'name' | 'description' | 'details_url', value: string) => {
      const layout = { ...((audit.layout as Record<string, unknown>) ?? {}) };
      const rs = { ...((layout.revenue_summary as Record<string, unknown>) ?? {}) };
      const blocks = { ...((rs.blocks as Record<string, unknown>) ?? {}) };
      const addOns = { ...((blocks.addOns as Record<string, unknown>) ?? {}) };
      const items = [...((addOns.items as RevenueOpportunityAddOnItem[]) ?? [])];
      const idx = items.findIndex(i => `${i.template_slug}-${i.display_order}` === itemKey);
      if (idx < 0) return;
      const nextValue = field === 'details_url' ? (value.trim() || null) : value;
      items[idx] = { ...items[idx], [field]: nextValue };
      addOns.items = items;
      blocks.addOns = addOns;
      rs.blocks = blocks;
      layout.revenue_summary = rs;
      onAuditChange({ ...audit, layout });
      schedule('layout-addons', async () => {
        await updateAudit(audit.id, { layout });
      });
    },
    [audit, onAuditChange, schedule],
  );

  const updateAddOnRevenue = useCallback(
    (itemKey: string, value: number) => {
      const layout = { ...((audit.layout as Record<string, unknown>) ?? {}) };
      const rs = { ...((layout.revenue_summary as Record<string, unknown>) ?? {}) };
      const blocks = { ...((rs.blocks as Record<string, unknown>) ?? {}) };
      const addOns = { ...((blocks.addOns as Record<string, unknown>) ?? {}) };
      const items = [...((addOns.items as RevenueOpportunityAddOnItem[]) ?? [])];
      const idx = items.findIndex(i => `${i.template_slug}-${i.display_order}` === itemKey);
      if (idx < 0) return;
      items[idx] = { ...items[idx], revenue_monthly: value };
      addOns.items = items;
      blocks.addOns = addOns;
      rs.blocks = blocks;
      layout.revenue_summary = rs;
      const nextAudit = { ...audit, layout };
      const total = computeAuditTotalRevenueOpportunity(sections, layout);
      onAuditChange({ ...nextAudit, total_revenue_opportunity: total });
      schedule('layout-addons', async () => {
        await updateAudit(audit.id, {
          layout,
          ...(total !== audit.total_revenue_opportunity ? { total_revenue_opportunity: total } : {}),
        });
      });
    },
    [audit, onAuditChange, sections, schedule],
  );

  const updateAddOnPrice = useCallback(
    (
      itemKey: string,
      field: 'one_time_price' | 'one_time_label' | 'monthly_price' | 'monthly_label',
      value: number | string | null,
    ) => {
      const layout = { ...((audit.layout as Record<string, unknown>) ?? {}) };
      const rs = { ...((layout.revenue_summary as Record<string, unknown>) ?? {}) };
      const blocks = { ...((rs.blocks as Record<string, unknown>) ?? {}) };
      const addOns = { ...((blocks.addOns as Record<string, unknown>) ?? {}) };
      const items = [...((addOns.items as RevenueOpportunityAddOnItem[]) ?? [])];
      const idx = items.findIndex(i => `${i.template_slug}-${i.display_order}` === itemKey);
      if (idx < 0) return;
      const nextValue =
        field === 'one_time_label' || field === 'monthly_label'
          ? (typeof value === 'string' ? (value.trim() || null) : null)
          : (value == null || value === '' ? null : Number(value));
      items[idx] = { ...items[idx], [field]: nextValue };
      addOns.items = items;
      blocks.addOns = addOns;
      rs.blocks = blocks;
      layout.revenue_summary = rs;
      onAuditChange({ ...audit, layout });
      schedule('layout-addons', async () => {
        await updateAudit(audit.id, { layout });
      });
    },
    [audit, onAuditChange, schedule],
  );

  const updateAddOnContent = useCallback(
    (itemKey: string, value: string) => {
      const layout = { ...((audit.layout as Record<string, unknown>) ?? {}) };
      const rs = { ...((layout.revenue_summary as Record<string, unknown>) ?? {}) };
      const blocks = { ...((rs.blocks as Record<string, unknown>) ?? {}) };
      const addOns = { ...((blocks.addOns as Record<string, unknown>) ?? {}) };
      const items = [...((addOns.items as RevenueOpportunityAddOnItem[]) ?? [])];
      const idx = items.findIndex(i => `${i.template_slug}-${i.display_order}` === itemKey);
      if (idx < 0) return;
      items[idx] = { ...items[idx], content: value };
      addOns.items = items;
      blocks.addOns = addOns;
      rs.blocks = blocks;
      layout.revenue_summary = rs;
      onAuditChange({ ...audit, layout });
      schedule('layout-addons', async () => {
        await updateAudit(audit.id, { layout });
      });
    },
    [audit, onAuditChange, schedule],
  );

  const updateAddOnImage = useCallback(
    (itemKey: string, value: string | null) => {
      const layout = { ...((audit.layout as Record<string, unknown>) ?? {}) };
      const rs = { ...((layout.revenue_summary as Record<string, unknown>) ?? {}) };
      const blocks = { ...((rs.blocks as Record<string, unknown>) ?? {}) };
      const addOns = { ...((blocks.addOns as Record<string, unknown>) ?? {}) };
      const items = [...((addOns.items as RevenueOpportunityAddOnItem[]) ?? [])];
      const idx = items.findIndex(i => `${i.template_slug}-${i.display_order}` === itemKey);
      if (idx < 0) return;
      const prev = items[idx];
      items[idx] = {
        ...prev,
        image_url: value,
        image_scale: value && value === prev.image_url ? prev.image_scale : undefined,
      };
      addOns.items = items;
      blocks.addOns = addOns;
      rs.blocks = blocks;
      layout.revenue_summary = rs;
      onAuditChange({ ...audit, layout });
      schedule('layout-addons', async () => {
        await updateAudit(audit.id, { layout });
      });
    },
    [audit, onAuditChange, schedule],
  );

  const updateAddOnImageScale = useCallback(
    (itemKey: string, scale: number) => {
      const layout = { ...((audit.layout as Record<string, unknown>) ?? {}) };
      const rs = { ...((layout.revenue_summary as Record<string, unknown>) ?? {}) };
      const blocks = { ...((rs.blocks as Record<string, unknown>) ?? {}) };
      const addOns = { ...((blocks.addOns as Record<string, unknown>) ?? {}) };
      const items = [...((addOns.items as RevenueOpportunityAddOnItem[]) ?? [])];
      const idx = items.findIndex(i => `${i.template_slug}-${i.display_order}` === itemKey);
      if (idx < 0) return;
      items[idx] = { ...items[idx], image_scale: normalizeImageScale(scale) };
      addOns.items = items;
      blocks.addOns = addOns;
      rs.blocks = blocks;
      layout.revenue_summary = rs;
      onAuditChange({ ...audit, layout });
      schedule('layout-addons', async () => {
        await updateAudit(audit.id, { layout });
      });
    },
    [audit, onAuditChange, schedule],
  );

  const patchAddOnItem = useCallback(
    (
      itemKey: string,
      mutator: (item: RevenueOpportunityAddOnItem) => RevenueOpportunityAddOnItem,
      persist = true,
    ) => {
      const layout = { ...((audit.layout as Record<string, unknown>) ?? {}) };
      const rs = { ...((layout.revenue_summary as Record<string, unknown>) ?? {}) };
      const blocks = { ...((rs.blocks as Record<string, unknown>) ?? {}) };
      const addOns = { ...((blocks.addOns as Record<string, unknown>) ?? {}) };
      const items = [...((addOns.items as RevenueOpportunityAddOnItem[]) ?? [])];
      const idx = items.findIndex(i => `${i.template_slug}-${i.display_order}` === itemKey);
      if (idx < 0) return;
      items[idx] = mutator(items[idx]);
      addOns.items = items;
      blocks.addOns = addOns;
      rs.blocks = blocks;
      layout.revenue_summary = rs;
      onAuditChange({ ...audit, layout });
      if (!persist) return;
      schedule('layout-addons', async () => {
        await updateAudit(audit.id, { layout });
      });
    },
    [audit, onAuditChange, schedule],
  );

  const setAddOnTalkTrackForSection = useCallback(
    (itemKey: string, sectionKey: AuditSectionKey, enabled: boolean) => {
      patchAddOnItem(itemKey, item => {
        const keys = item.related_section_keys ?? [];
        if (enabled) {
          const next = keys.includes(sectionKey) ? keys : [...keys, sectionKey];
          return { ...item, highlighted: true, related_section_keys: next };
        }
        const next = keys.filter(key => key !== sectionKey);
        return {
          ...item,
          related_section_keys: next.length > 0 ? next : undefined,
        };
      });
    },
    [patchAddOnItem],
  );

  const updateAddOnPresenterNote = useCallback(
    (itemKey: string, note: string) => {
      patchAddOnItem(itemKey, item => ({
        ...item,
        presenter_note: note.trim() || undefined,
      }));
    },
    [patchAddOnItem],
  );

  const toggleAddOnInvestmentIncluded = useCallback(
    (itemKey: string, included: boolean) => {
      // Outside edit mode (public link) the toggle is local only: never saved.
      patchAddOnItem(
        itemKey,
        item => ({
          ...item,
          investment_included: included,
        }),
        editMode,
      );
    },
    [patchAddOnItem, editMode],
  );

  const updateAttributionScreenshot = useCallback(
    (value: string | null) => {
      const layout = { ...((audit.layout as Record<string, unknown>) ?? {}) };
      const prev = (layout.attribution_model as Record<string, unknown> | undefined) ?? {};
      const section = {
        ...prev,
        screenshot_url: value,
        screenshot_scale: value && value === prev.screenshot_url ? prev.screenshot_scale : undefined,
      };
      layout.attribution_model = section;
      onAuditChange({ ...audit, layout });
      schedule('layout-attribution', async () => {
        await updateAudit(audit.id, { layout });
      });
    },
    [audit, onAuditChange, schedule],
  );

  const updateAttributionScreenshotScale = useCallback(
    (scale: number) => {
      const layout = { ...((audit.layout as Record<string, unknown>) ?? {}) };
      const section = {
        ...((layout.attribution_model as Record<string, unknown>) ?? {}),
        screenshot_scale: normalizeImageScale(scale),
      };
      layout.attribution_model = section;
      onAuditChange({ ...audit, layout });
      schedule('layout-attribution', async () => {
        await updateAudit(audit.id, { layout });
      });
    },
    [audit, onAuditChange, schedule],
  );

  const toggleLayoutSectionHidden = useCallback(
    (layoutKey: LayoutSectionKey, hidden: boolean) => {
      patchLayout(layoutKey, section => ({ ...section, hidden: hidden || undefined }));
    },
    [patchLayout],
  );

  const toggleAuditSectionHidden = useCallback(
    (sectionKey: string, hidden: boolean) => {
      const section = sections.find(s => s.section_key === sectionKey);
      if (!section) return;
      const sectionConfig = (section.section_config as Record<string, unknown> | null | undefined) ?? {};
      const nextConfig =
        sectionKey === 'flows'
          ? writeFlowsConfigPatch(sectionConfig, { hidden: hidden || undefined })
          : writeGenericConfigPatch(sectionConfig, sectionKey, { hidden: hidden || undefined });
      const nextSections = sections.map(s =>
        s.id === section.id ? { ...s, section_config: nextConfig } : s,
      );
      onSectionsChange(nextSections);
      syncAuditTotalRevenue(nextSections, audit);
      schedule(`section-hidden-${section.id}`, async () => {
        await updateAuditSection(section.id, { section_config: nextConfig });
      });
    },
    [sections, onSectionsChange, schedule, syncAuditTotalRevenue, audit],
  );

  const toggleExecutiveBlockHidden = useCallback(
    (blockKey: string, hidden: boolean) => {
      const layout = writeExecutiveBlockPatch(
        (audit.layout as Record<string, unknown>) ?? {},
        blockKey,
        { hidden: hidden || undefined },
      );
      onAuditChange({ ...audit, layout });
      schedule(`layout-exec-block-${blockKey}`, async () => {
        await updateAudit(audit.id, { layout });
      });
    },
    [audit, onAuditChange, schedule],
  );

  const toggleRevenueBlockHidden = useCallback(
    (blockKey: string, hidden: boolean) => {
      const layout = writeRevenueBlockPatch(
        (audit.layout as Record<string, unknown>) ?? {},
        blockKey,
        { hidden },
      );
      onAuditChange({ ...audit, layout });
      schedule(`layout-rev-block-${blockKey}`, async () => {
        await updateAudit(audit.id, { layout });
      });
    },
    [audit, onAuditChange, schedule],
  );

  const toggleSectionBlockHidden = useCallback(
    (sectionKey: string, blockKey: string, hidden: boolean) => {
      const section = sections.find(s => s.section_key === sectionKey);
      if (!section) return;
      const sectionConfig = (section.section_config as Record<string, unknown> | null | undefined) ?? {};
      const nextConfig =
        sectionKey === 'flows'
          ? writeFlowsBlockPatch(sectionConfig, blockKey, { hidden: hidden || undefined })
          : writeGenericBlockPatch(sectionConfig, sectionKey, blockKey, { hidden: hidden || undefined });
      const nextSections = sections.map(s =>
        s.id === section.id ? { ...s, section_config: nextConfig } : s,
      );
      onSectionsChange(nextSections);
      schedule(`section-block-${section.id}-${blockKey}`, async () => {
        await updateAuditSection(section.id, { section_config: nextConfig });
      });
    },
    [sections, onSectionsChange, schedule],
  );

  const toggleFlowsBlockHidden = useCallback(
    (blockKey: string, hidden: boolean) => toggleSectionBlockHidden('flows', blockKey, hidden),
    [toggleSectionBlockHidden],
  );

  const toggleSectionKeyFindingsBlockHidden = useCallback(
    (targetKey: string, hidden: boolean) => {
      if (isLayoutKeyFindingsKey(targetKey)) {
        patchLayout(targetKey, section => {
          const blocks = { ...((section.blocks as Record<string, unknown>) ?? {}) };
          const block = { ...((blocks.keyFindings as Record<string, unknown>) ?? {}), hidden: hidden || undefined };
          blocks.keyFindings = block;
          return { ...section, blocks };
        });
        return;
      }
      if (targetKey === 'flows') {
        toggleFlowsBlockHidden('keyFindings', hidden);
        return;
      }
      toggleSectionBlockHidden(targetKey, 'keyFindings', hidden);
    },
    [patchLayout, toggleFlowsBlockHidden, toggleSectionBlockHidden],
  );

  const toggleFindingHidden = useCallback(
    (index: number, hidden: boolean) => {
      const prev = getExecPayload();
      const findingsHidden = [...(prev.findingsHidden ?? [])];
      while (findingsHidden.length <= index) findingsHidden.push(false);
      findingsHidden[index] = hidden;
      saveExecutive({ findingsHidden });
    },
    [getExecPayload, saveExecutive],
  );

  const toggleStrengthHidden = useCallback(
    (index: number, hidden: boolean) => {
      const prev = getExecPayload();
      const strengthsHidden = [...(prev.strengthsHidden ?? [])];
      while (strengthsHidden.length <= index) strengthsHidden.push(false);
      strengthsHidden[index] = hidden;
      saveExecutive({ strengthsHidden });
    },
    [getExecPayload, saveExecutive],
  );

  const toggleTimelinePhaseHidden = useCallback(
    (index: number, hidden: boolean) => {
      const prev = getExecPayload();
      const timelineHidden = [...(prev.timelineHidden ?? [])];
      while (timelineHidden.length <= index) timelineHidden.push(false);
      timelineHidden[index] = hidden;
      saveExecutive({ timelineHidden });
    },
    [getExecPayload, saveExecutive],
  );

  const patchSectionBlock = useCallback(
    (sectionKey: string, blockKey: string, patch: Record<string, unknown>) => {
      const section = sections.find(s => s.section_key === sectionKey);
      if (!section) return;
      const sectionConfig = (section.section_config as Record<string, unknown> | null | undefined) ?? {};
      const nextConfig =
        sectionKey === 'flows'
          ? writeFlowsBlockPatch(sectionConfig, blockKey, patch)
          : writeGenericBlockPatch(sectionConfig, sectionKey, blockKey, patch);
      const nextSections = sections.map(s =>
        s.id === section.id ? { ...s, section_config: nextConfig } : s,
      );
      onSectionsChange(nextSections);
      schedule(`section-block-patch-${section.id}-${blockKey}`, async () => {
        await updateAuditSection(section.id, { section_config: nextConfig });
      });
    },
    [sections, onSectionsChange, schedule],
  );

  const updateSectionBlockField = useCallback(
    (
      sectionKey: string,
      blockKey: string,
      field: 'title' | 'subtitle' | 'currentTitle' | 'optimizedTitle',
      value: string,
    ) => {
      patchSectionBlock(sectionKey, blockKey, { [field]: value || undefined });
    },
    [patchSectionBlock],
  );

  const updateSectionDetailField = useCallback(
    (sectionKey: string, path: string[], value: string) => {
      const section = sections.find(s => s.section_key === sectionKey);
      if (!section || path.length === 0) return;
      const raw = section.section_details;
      const details: Record<string, unknown> =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? { ...(raw as Record<string, unknown>) }
          : typeof raw === 'string'
            ? (() => {
                try {
                  const parsed = JSON.parse(raw);
                  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? { ...(parsed as Record<string, unknown>) }
                    : {};
                } catch {
                  return {};
                }
              })()
            : {};
      let cursor: Record<string, unknown> = details;
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        const next =
          cursor[key] && typeof cursor[key] === 'object' && !Array.isArray(cursor[key])
            ? { ...(cursor[key] as Record<string, unknown>) }
            : {};
        cursor[key] = next;
        cursor = next;
      }
      cursor[path[path.length - 1]] = value;
      const nextSections = sections.map(s =>
        s.id === section.id ? { ...s, section_details: details } : s,
      );
      onSectionsChange(nextSections);
      schedule(`section-detail-${section.id}-${path.join('.')}`, async () => {
        await updateAuditSection(section.id, { section_details: details });
      });
    },
    [sections, onSectionsChange, schedule],
  );

  // Same deep-patch as updateSectionDetailField but for arbitrary values
  // (arrays/objects/booleans) - used by the web report for findings, highlight
  // boxes, roadmap rows, and hidden flags stored in section_details.
  const updateSectionDetailValue = useCallback(
    (sectionKey: string, path: string[], value: unknown) => {
      const section = sections.find(s => s.section_key === sectionKey);
      if (!section || path.length === 0) return;
      const raw = section.section_details;
      const details: Record<string, unknown> =
        raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
      let cursor: Record<string, unknown> = details;
      for (let i = 0; i < path.length - 1; i++) {
        const key = path[i];
        const next =
          cursor[key] && typeof cursor[key] === 'object' && !Array.isArray(cursor[key])
            ? { ...(cursor[key] as Record<string, unknown>) }
            : {};
        cursor[key] = next;
        cursor = next;
      }
      cursor[path[path.length - 1]] = value;
      const nextSections = sections.map(s => (s.id === section.id ? { ...s, section_details: details } : s));
      onSectionsChange(nextSections);
      schedule(`section-detail-${section.id}-${path.join('.')}`, async () => {
        await updateAuditSection(section.id, { section_details: details });
      });
    },
    [sections, onSectionsChange, schedule],
  );

  const updateCoreFlowMatrixNote = useCallback(
    (
      sectionKey: string,
      rowIndex: number,
      field: 'current_structure_note' | 'recommended_structure',
      value: string,
    ) => {
      const section = sections.find(s => s.section_key === sectionKey);
      if (!section) return;
      const raw = section.section_details;
      const details: Record<string, unknown> =
        raw && typeof raw === 'object' && !Array.isArray(raw)
          ? { ...(raw as Record<string, unknown>) }
          : typeof raw === 'string'
            ? (() => {
                try {
                  const parsed = JSON.parse(raw);
                  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? { ...(parsed as Record<string, unknown>) }
                    : {};
                } catch {
                  return {};
                }
              })()
            : {};
      const flows = details.flows;
      const flowsObj =
        flows && typeof flows === 'object' && !Array.isArray(flows)
          ? { ...(flows as Record<string, unknown>) }
          : {};
      const coreFlows = Array.isArray(flowsObj.core_flows)
        ? (flowsObj.core_flows as CoreFlowRow[])
        : [];
      const normalized = normalizeCoreFlowsMatrix(coreFlows);
      if (rowIndex < 0 || rowIndex >= normalized.length) return;
      normalized[rowIndex] = {
        ...normalized[rowIndex],
        [field]: sanitizeStructureNote(value),
      };
      details.flows = { ...flowsObj, core_flows: normalized };
      const nextSections = sections.map(s =>
        s.id === section.id ? { ...s, section_details: details } : s,
      );
      onSectionsChange(nextSections);
      schedule(`core-flow-${section.id}-${rowIndex}-${field}`, async () => {
        await updateAuditSection(section.id, { section_details: details });
      });
    },
    [sections, onSectionsChange, schedule],
  );

  const value = useMemo(
    () => ({
      editMode,
      investmentToggleMode,
      saveStatus,
      updateFinding,
      addFinding,
      removeFinding,
      updateStrength,
      updateExecText,
      updateSectionField,
      updateLayoutTitle,
      updateBlockTitle,
      updateTimelinePhase,
      updateTimelineItem,
      updateAddOnField,
      updateAddOnRevenue,
      updateAddOnPrice,
      updateAddOnContent,
      updateAddOnImage,
      updateAddOnImageScale,
      setAddOnTalkTrackForSection,
      updateAddOnPresenterNote,
      toggleAddOnInvestmentIncluded,
      updateAttributionScreenshot,
      updateAttributionScreenshotScale,
      updateSectionRevenueOpportunity,
      toggleLayoutSectionHidden,
      toggleAuditSectionHidden,
      toggleExecutiveBlockHidden,
      toggleRevenueBlockHidden,
      toggleSectionBlockHidden,
      toggleFlowsBlockHidden,
      toggleFindingHidden,
      toggleStrengthHidden,
      toggleTimelinePhaseHidden,
      updateSectionKeyFinding,
      addSectionKeyFinding,
      removeSectionKeyFinding,
      toggleSectionKeyFindingHidden,
      toggleSectionKeyFindingsBlockHidden,
      updateLayoutBlockTitle,
      updateSectionBlockField,
      updateSectionDetailField,
      updateSectionDetailValue,
      updateCoreFlowMatrixNote,
      patchSectionBlock,
      flushSaves,
    }),
    [
      editMode,
      investmentToggleMode,
      saveStatus,
      updateFinding,
      addFinding,
      removeFinding,
      updateStrength,
      updateExecText,
      updateSectionField,
      updateLayoutTitle,
      updateBlockTitle,
      updateTimelinePhase,
      updateTimelineItem,
      updateAddOnField,
      updateAddOnRevenue,
      updateAddOnPrice,
      updateAddOnContent,
      updateAddOnImage,
      updateAddOnImageScale,
      setAddOnTalkTrackForSection,
      updateAddOnPresenterNote,
      toggleAddOnInvestmentIncluded,
      updateAttributionScreenshot,
      updateAttributionScreenshotScale,
      updateSectionRevenueOpportunity,
      toggleLayoutSectionHidden,
      toggleAuditSectionHidden,
      toggleExecutiveBlockHidden,
      toggleRevenueBlockHidden,
      toggleSectionBlockHidden,
      toggleFlowsBlockHidden,
      toggleFindingHidden,
      toggleStrengthHidden,
      toggleTimelinePhaseHidden,
      updateSectionKeyFinding,
      addSectionKeyFinding,
      removeSectionKeyFinding,
      toggleSectionKeyFindingHidden,
      toggleSectionKeyFindingsBlockHidden,
      updateLayoutBlockTitle,
      updateSectionBlockField,
      updateSectionDetailField,
      updateSectionDetailValue,
      updateCoreFlowMatrixNote,
      patchSectionBlock,
      flushSaves,
    ],
  );

  return (
    <ReportEditContext.Provider value={value}>
      {children}
    </ReportEditContext.Provider>
  );
}

export { parseExecutiveSummary };
