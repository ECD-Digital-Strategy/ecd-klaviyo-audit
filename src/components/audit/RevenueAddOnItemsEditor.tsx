import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Eye,
  EyeOff,
  GripVertical,
  Plus,
  Sparkles,
} from 'lucide-react';
import type { Audit, RevenueOpportunityAddOnItem, RevenueOpportunityTemplate } from '../../lib/types';
import { listRevenueOpportunityTemplates, updateAudit, uploadRevenueOpportunityImage } from '../../lib/db';
import { resolveRevenueOpportunityContent } from '../../lib/revenue-opportunity-content';
import { summarizeTemplatePricing } from '../../lib/revenue-addon-categories';
import { getHighlightedAddOns, AUDIT_SECTION_OPTIONS } from '../../lib/addon-highlight';
import { regenerateAuditForHighlights } from '../../lib/audit-pipeline-status';
import { scheduleSavedToast, useToast } from '../ui/Toast';
import SimpleRichEditor from '../ui/SimpleRichEditor';
import ImageUploadZone from '../ui/ImageUploadZone';
import AddOnHighlightRegenModal from './AddOnHighlightRegenModal';
import AddOpportunityPickerModal from './AddOpportunityPickerModal';
import BrandedCheckbox from '../ui/BrandedCheckbox';
import { cn } from '../../lib/utils';

function normalizeItems(rawItems: unknown): RevenueOpportunityAddOnItem[] {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .filter((item): item is RevenueOpportunityAddOnItem => !!item && typeof item === 'object')
    .map((item, index) => ({
      template_slug: String(item.template_slug ?? ''),
      name: String(item.name ?? ''),
      description: item.description ? String(item.description) : undefined,
      content: resolveRevenueOpportunityContent(item),
      bullets: Array.isArray(item.bullets) ? item.bullets.map(v => String(v)) : [],
      revenue_monthly: Number(item.revenue_monthly ?? 0),
      one_time_price: item.one_time_price != null ? Number(item.one_time_price) : null,
      one_time_label: item.one_time_label ? String(item.one_time_label) : null,
      monthly_price: item.monthly_price != null ? Number(item.monthly_price) : null,
      monthly_label: item.monthly_label ? String(item.monthly_label) : null,
      image_url: item.image_url ?? null,
      image_scale: item.image_scale ?? null,
      details_url: item.details_url ?? null,
      is_hidden: Boolean(item.is_hidden),
      highlighted: Boolean(item.highlighted),
      related_section_keys: Array.isArray(item.related_section_keys)
        ? item.related_section_keys.map(v => String(v))
        : undefined,
      presenter_note: item.presenter_note ? String(item.presenter_note) : undefined,
      investment_included: item.investment_included !== false,
      display_order: typeof item.display_order === 'number' ? item.display_order : (index + 1) * 10,
    }))
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
}

function summarizeItemPricing(item: RevenueOpportunityAddOnItem): string | null {
  return summarizeTemplatePricing(item);
}

function AddOnListRow({
  item,
  selected,
  dragActive,
  onSelect,
  onDragStart,
  onDragEnd,
  onDrop,
  onToggleHighlight,
  onToggleHidden,
  onToggleInvestmentIncluded,
}: {
  item: RevenueOpportunityAddOnItem;
  selected: boolean;
  dragActive: boolean;
  onSelect: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  onToggleHighlight: () => void;
  onToggleHidden: () => void;
  onToggleInvestmentIncluded: () => void;
}) {
  const pricing = summarizeItemPricing(item);

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={e => e.preventDefault()}
      onDrop={onDrop}
      className={cn(
        'rounded-lg border transition-colors',
        selected
          ? 'border-brand-primary/40 bg-brand-primary/[0.06] shadow-sm'
          : dragActive
            ? 'border-brand-primary/30 bg-brand-primary/[0.03]'
            : 'border-transparent bg-white hover:border-gray-200 hover:bg-gray-50',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-start gap-2 px-2.5 py-2.5 text-left"
      >
        <GripVertical className="mt-0.5 h-4 w-4 shrink-0 cursor-grab text-gray-300 active:cursor-grabbing" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn('truncate text-sm font-medium', item.is_hidden ? 'text-gray-400' : 'text-gray-900')}>
              {item.name || 'Untitled'}
            </span>
            {item.highlighted ? (
              <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="Highlighted" />
            ) : null}
          </div>
          {pricing ? (
            <p className="mt-0.5 truncate text-[11px] text-gray-500">{pricing}</p>
          ) : (
            <p className="mt-0.5 text-[11px] text-gray-400">No pricing set</p>
          )}
        </div>
      </button>
      <div className="flex items-center justify-end gap-1 border-t border-gray-100/80 px-2 pb-2 pt-1">
        <button
          type="button"
          title={item.highlighted ? 'Remove highlight' : 'Highlight in report'}
          onClick={e => {
            e.stopPropagation();
            onToggleHighlight();
          }}
          className={cn(
            'rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wide',
            item.highlighted
              ? 'bg-amber-100 text-amber-800'
              : 'text-gray-500 hover:bg-gray-100',
          )}
        >
          {item.highlighted ? 'Highlighted' : 'Highlight'}
        </button>
        <button
          type="button"
          title={item.investment_included === false ? 'Include in Investment Summary' : 'Exclude from Investment Summary'}
          onClick={e => {
            e.stopPropagation();
            onToggleInvestmentIncluded();
          }}
          className={cn(
            'rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wide',
            item.investment_included === false
              ? 'text-gray-500 hover:bg-gray-100'
              : 'bg-emerald-100 text-emerald-800',
          )}
        >
          {item.investment_included === false ? 'Excluded' : 'In proposal'}
        </button>
        <button
          type="button"
          title={item.is_hidden ? 'Show in report' : 'Hide from report'}
          onClick={e => {
            e.stopPropagation();
            onToggleHidden();
          }}
          className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
        >
          {item.is_hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

function AddOnDetailPanel({
  item,
  index,
  total,
  uploading,
  onChange,
  onMove,
  onRemove,
  onImageUpload,
}: {
  item: RevenueOpportunityAddOnItem;
  index: number;
  total: number;
  uploading: boolean;
  onChange: (next: RevenueOpportunityAddOnItem) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onImageUpload: (file: File | undefined) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 pb-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400">
            Editing · {index + 1} of {total}
          </p>
          <h4 className="mt-1 text-lg font-semibold text-gray-900">{item.name}</h4>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            className="rounded-lg border border-gray-200 p-2 text-gray-500 hover:bg-gray-50 disabled:opacity-40"
            title="Move up"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={index >= total - 1}
            className="rounded-lg border border-gray-200 p-2 text-gray-500 hover:bg-gray-50 disabled:opacity-40"
            title="Move down"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-medium text-gray-500">Display name</label>
        <input
          type="text"
          value={item.name}
          onChange={e => onChange({ ...item, name: e.target.value })}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-[11px] font-medium text-gray-500">One-time price ($)</label>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={item.one_time_price != null && item.one_time_price > 0 ? String(item.one_time_price) : ''}
            onChange={e => {
              const raw = e.target.value.replace(/[^0-9.]/g, '');
              onChange({ ...item, one_time_price: raw === '' ? null : Number(raw) });
            }}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-gray-500">One-time note</label>
          <input
            type="text"
            placeholder="e.g. Full $2,500 · Mini $500"
            value={item.one_time_label ?? ''}
            onChange={e => onChange({ ...item, one_time_label: e.target.value.trim() || null })}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-gray-500">Monthly retainer ($)</label>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0"
            value={item.monthly_price != null && item.monthly_price > 0 ? String(item.monthly_price) : ''}
            onChange={e => {
              const raw = e.target.value.replace(/[^0-9.]/g, '');
              onChange({ ...item, monthly_price: raw === '' ? null : Number(raw) });
            }}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
          />
        </div>
        <div>
          <label className="mb-1 block text-[11px] font-medium text-gray-500">Monthly note</label>
          <input
            type="text"
            placeholder="e.g. $12,000+/mo"
            value={item.monthly_label ?? ''}
            onChange={e => onChange({ ...item, monthly_label: e.target.value.trim() || null })}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-medium text-gray-500">Short description</label>
        <input
          type="text"
          value={item.description ?? ''}
          onChange={e => onChange({ ...item, description: e.target.value || undefined })}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
        />
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-medium text-gray-500">Report body</label>
        <SimpleRichEditor
          value={item.content ?? ''}
          onChange={value => onChange({ ...item, content: value })}
          rows={5}
          placeholder="Paragraphs or bullet lists — use the list button in the toolbar."
        />
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-medium text-gray-500">Screenshot</label>
        <ImageUploadZone
          compact
          previewUrl={item.image_url}
          previewAlt={`${item.name} screenshot`}
          label={item.image_url ? 'Replace screenshot' : 'Upload screenshot'}
          uploading={uploading}
          onFile={onImageUpload}
          onRemove={item.image_url ? () => onChange({ ...item, image_url: null, image_scale: undefined }) : undefined}
          imageScale={item.image_scale}
          onImageScaleChange={scale => onChange({ ...item, image_scale: scale })}
          resizable={Boolean(item.image_url)}
          className="max-w-md"
        />
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-medium text-gray-500">Details doc URL</label>
        <input
          type="url"
          placeholder="https://…"
          value={item.details_url ?? ''}
          onChange={e => onChange({ ...item, details_url: e.target.value.trim() || null })}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
        />
      </div>

      {item.highlighted ? (
        <div className="space-y-4 rounded-xl border border-amber-200/70 bg-amber-50/40 p-4">
          <div>
            <p className="text-xs font-semibold text-gray-900">Discuss in sections</p>
            <p className="mt-0.5 text-[11px] text-gray-600">
              Choose where this add-on appears as a talk-track pill next to the section heading in the report.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {AUDIT_SECTION_OPTIONS.map(option => {
                const selected = (item.related_section_keys ?? []).includes(option.key);
                return (
                  <div
                    key={option.key}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors',
                      selected
                        ? 'border-amber-300 bg-white text-gray-900'
                        : 'border-transparent bg-white/70 text-gray-700 hover:border-gray-200',
                    )}
                  >
                    <BrandedCheckbox
                      checked={selected}
                      onChange={() => {
                        const current = item.related_section_keys ?? [];
                        const next = selected
                          ? current.filter(key => key !== option.key)
                          : [...current, option.key];
                        onChange({
                          ...item,
                          related_section_keys: next.length > 0 ? next : undefined,
                        });
                      }}
                      aria-label={`Discuss in ${option.label}`}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const current = item.related_section_keys ?? [];
                        const next = selected
                          ? current.filter(key => key !== option.key)
                          : [...current, option.key];
                        onChange({
                          ...item,
                          related_section_keys: next.length > 0 ? next : undefined,
                        });
                      }}
                      className="text-left text-xs font-medium"
                    >
                      {option.label}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <details className="group">
            <summary className="cursor-pointer text-xs font-semibold text-gray-800 marker:content-none">
              <span className="inline-flex items-center gap-1">
                Presenter note
                <span className="font-normal text-gray-500">(optional · shown on hover in report)</span>
              </span>
            </summary>
            <textarea
              rows={3}
              placeholder="One-line cue for what to show the client at those sections…"
              value={item.presenter_note ?? ''}
              onChange={e => onChange({
                ...item,
                presenter_note: e.target.value.trim() || undefined,
              })}
              className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
            />
          </details>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
            <span className="text-xs font-medium text-gray-700">Show in report</span>
            <button
              type="button"
              role="switch"
              aria-checked={!item.is_hidden}
              onClick={() => onChange({ ...item, is_hidden: !item.is_hidden })}
              className={cn(
                'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors',
                !item.is_hidden ? 'bg-brand-primary' : 'bg-gray-200',
              )}
            >
              <span
                className={cn(
                  'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                  !item.is_hidden ? 'translate-x-4' : 'translate-x-0',
                )}
              />
            </button>
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
            <span className="text-xs font-medium text-gray-700">Investment Summary</span>
            <button
              type="button"
              role="switch"
              aria-checked={item.investment_included !== false}
              onClick={() => onChange({ ...item, investment_included: item.investment_included === false })}
              className={cn(
                'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors',
                item.investment_included !== false ? 'bg-emerald-600' : 'bg-gray-200',
              )}
            >
              <span
                className={cn(
                  'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                  item.investment_included !== false ? 'translate-x-4' : 'translate-x-0',
                )}
              />
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-sm font-medium text-red-600 hover:underline"
        >
          Remove from audit
        </button>
      </div>
    </div>
  );
}

export default function RevenueAddOnItemsEditor({
  audit,
  onAuditChange,
  hasAnalysisContent = false,
  onHighlightRegenStart,
}: {
  audit: Audit;
  onAuditChange: (next: Audit) => void;
  hasAnalysisContent?: boolean;
  onHighlightRegenStart?: () => void;
}) {
  const [templates, setTemplates] = useState<RevenueOpportunityTemplate[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);
  const [regenModalOpen, setRegenModalOpen] = useState(false);
  const [regenRunning, setRegenRunning] = useState(false);
  const saveTimer = useRef<number | null>(null);
  // The debounced layout write, kept so unmount can flush it and a highlight write can replace it.
  const pendingSave = useRef<(() => Promise<void>) | null>(null);
  const toast = useToast();

  const layout = useMemo(
    () => ((audit.layout as Record<string, unknown> | null | undefined) ?? {}),
    [audit.layout],
  );
  const addOnItems = useMemo(() => {
    const revenueSummary = layout.revenue_summary as Record<string, unknown> | undefined;
    const blocks = revenueSummary?.blocks as Record<string, unknown> | undefined;
    const addOns = blocks?.addOns as Record<string, unknown> | undefined;
    return normalizeItems(addOns?.items);
  }, [layout]);

  const availableTemplates = useMemo(
    () => templates.filter(template => !addOnItems.some(item => item.template_slug === template.slug)),
    [templates, addOnItems],
  );

  const visibleCount = useMemo(() => addOnItems.filter(item => !item.is_hidden).length, [addOnItems]);
  const highlightedCount = useMemo(() => addOnItems.filter(item => item.highlighted).length, [addOnItems]);

  useEffect(() => {
    // Only offer services that apply to this audit's type (plus 'both').
    const auditType = audit.audit_type === 'web' ? 'web' : 'klaviyo';
    listRevenueOpportunityTemplates({ activeOnly: true, auditType })
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, [audit.audit_type]);

  // Closing the drawer: send the last edit now instead of dropping it.
  useEffect(() => () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const save = pendingSave.current;
    pendingSave.current = null;
    if (save) void save();
  }, []);

  useEffect(() => {
    if (addOnItems.length === 0) {
      setSelectedIndex(null);
      setMobileShowDetail(false);
      return;
    }
    if (selectedIndex == null || selectedIndex >= addOnItems.length) {
      setSelectedIndex(0);
    }
  }, [addOnItems.length, selectedIndex]);

  const highlightedNames = useMemo(
    () => getHighlightedAddOns(addOnItems).map(item => item.name),
    [addOnItems],
  );

  const handleConfirmRegen = async () => {
    setRegenRunning(true);
    try {
      await regenerateAuditForHighlights(audit.id);
      onHighlightRegenStart?.();
      setRegenModalOpen(false);
    } catch {
      toast('Failed to start regeneration');
    } finally {
      setRegenRunning(false);
    }
  };

  const writeItems = (
    nextItems: RevenueOpportunityAddOnItem[],
    opts?: { highlightChanged?: boolean },
  ) => {
    const withOrder = nextItems.map((item, index) => ({
      ...item,
      content: item.content?.trim() || resolveRevenueOpportunityContent(item),
      display_order: (index + 1) * 10,
    }));
    const revenueSummary = (layout.revenue_summary as Record<string, unknown> | undefined) ?? {};
    const blocks = (revenueSummary.blocks as Record<string, unknown> | undefined) ?? {};
    const addOns = (blocks.addOns as Record<string, unknown> | undefined) ?? {};
    const nextLayout: Record<string, unknown> = {
      ...layout,
      revenue_summary: {
        ...revenueSummary,
        blocks: {
          ...blocks,
          addOns: {
            ...addOns,
            items: withOrder,
          },
        },
      },
    };
    onAuditChange({ ...audit, layout: nextLayout });

    // Any queued debounced write is older than nextLayout, which already holds it:
    // cancel it so it can't land later and undo this change.
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    pendingSave.current = null;

    if (opts?.highlightChanged) {
      void (async () => {
        try {
          await updateAudit(audit.id, { layout: nextLayout });
          scheduleSavedToast(toast);
          if (hasAnalysisContent) {
            setRegenModalOpen(true);
          }
        } catch {
          toast('Could not save');
        }
      })();
      return;
    }

    const save = async () => {
      try {
        await updateAudit(audit.id, { layout: nextLayout });
        scheduleSavedToast(toast);
      } catch {
        toast('Could not save');
      }
    };
    pendingSave.current = save;
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      if (pendingSave.current === save) pendingSave.current = null;
      void save();
    }, 800) as unknown as number;
  };

  const updateItemAt = (index: number, nextItem: RevenueOpportunityAddOnItem, opts?: { highlightChanged?: boolean }) => {
    const next = addOnItems.slice();
    next[index] = nextItem;
    writeItems(next, opts);
  };

  const toggleHighlighted = (index: number) => {
    const item = addOnItems[index];
    if (!item) return;
    const nextHighlighted = !item.highlighted;
    updateItemAt(
      index,
      {
        ...item,
        highlighted: nextHighlighted,
        related_section_keys: nextHighlighted ? item.related_section_keys : undefined,
        presenter_note: nextHighlighted ? item.presenter_note : undefined,
      },
      { highlightChanged: true },
    );
  };

  const toggleHidden = (index: number) => {
    const item = addOnItems[index];
    if (!item) return;
    updateItemAt(index, { ...item, is_hidden: !item.is_hidden });
  };

  const toggleInvestmentIncluded = (index: number) => {
    const item = addOnItems[index];
    if (!item) return;
    updateItemAt(index, {
      ...item,
      investment_included: item.investment_included === false,
    });
  };

  const moveItem = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= addOnItems.length) return;
    const next = addOnItems.slice();
    const temp = next[index];
    next[index] = next[target];
    next[target] = temp;
    writeItems(next);
    setSelectedIndex(target);
  };

  const removeItem = (index: number) => {
    const next = addOnItems.filter((_, i) => i !== index);
    writeItems(next);
    if (next.length === 0) {
      setSelectedIndex(null);
      setMobileShowDetail(false);
    } else {
      setSelectedIndex(Math.min(index, next.length - 1));
    }
  };

  const handleImageUpload = async (index: number, file: File | undefined) => {
    if (!file) return;
    setUploadingIndex(index);
    try {
      const url = await uploadRevenueOpportunityImage(file);
      const item = addOnItems[index];
      if (item) updateItemAt(index, { ...item, image_url: url, image_scale: undefined });
    } catch {
      toast('Image upload failed');
    } finally {
      setUploadingIndex(null);
    }
  };

  const addTemplate = (template: RevenueOpportunityTemplate) => {
    if (addOnItems.some(item => item.template_slug === template.slug)) return;
    const next = [
      ...addOnItems,
      {
        template_slug: template.slug,
        name: template.name,
        description: template.description || undefined,
        content: template.content || resolveRevenueOpportunityContent(template),
        bullets: [],
        revenue_monthly: 0,
        one_time_price: template.one_time_price ?? null,
        one_time_label: template.one_time_label ?? null,
        monthly_price: template.monthly_price ?? null,
        monthly_label: template.monthly_label ?? null,
        image_url: template.image_url ?? null,
        details_url: template.details_url ?? null,
        is_hidden: false,
      },
    ];
    writeItems(next);
    setSelectedIndex(next.length - 1);
    setMobileShowDetail(true);
    setPickerOpen(false);
  };

  const selectedItem = selectedIndex != null ? addOnItems[selectedIndex] : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <span className="rounded-full bg-gray-100 px-2.5 py-1 font-medium text-gray-700">
            {addOnItems.length} in audit
          </span>
          <span className="rounded-full bg-gray-100 px-2.5 py-1">
            {visibleCount} visible in report
          </span>
          {highlightedCount > 0 ? (
            <span className="rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-800">
              {highlightedCount} highlighted
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={availableTemplates.length === 0}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-3.5 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="h-4 w-4" />
          Add from library
        </button>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-gray-200 bg-gray-50/40">
        <aside
          className={cn(
            'flex w-full shrink-0 flex-col border-gray-200 bg-gray-50/80 md:w-[min(100%,280px)] md:border-r',
            mobileShowDetail ? 'hidden md:flex' : 'flex',
          )}
        >
          <div className="border-b border-gray-200 px-3 py-2.5">
            <p className="text-[11px] font-bold uppercase tracking-wider text-gray-500">In this audit</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {addOnItems.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-200 bg-white px-3 py-8 text-center">
                <p className="text-sm text-gray-600">No add-ons yet</p>
                <p className="mt-1 text-xs text-gray-400">Use Add from library to get started.</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {addOnItems.map((item, index) => (
                  <AddOnListRow
                    key={`${item.template_slug}-${index}`}
                    item={item}
                    selected={selectedIndex === index}
                    dragActive={dragIndex === index}
                    onSelect={() => {
                      setSelectedIndex(index);
                      setMobileShowDetail(true);
                    }}
                    onDragStart={() => setDragIndex(index)}
                    onDragEnd={() => setDragIndex(null)}
                    onDrop={() => {
                      if (dragIndex === null || dragIndex === index) return;
                      const next = addOnItems.slice();
                      const [moved] = next.splice(dragIndex, 1);
                      next.splice(index, 0, moved);
                      setDragIndex(null);
                      writeItems(next);
                      setSelectedIndex(index);
                    }}
                    onToggleHighlight={() => toggleHighlighted(index)}
                    onToggleHidden={() => toggleHidden(index)}
                    onToggleInvestmentIncluded={() => toggleInvestmentIncluded(index)}
                  />
                ))}
              </div>
            )}
          </div>
        </aside>

        <main
          className={cn(
            'min-h-0 flex-1 overflow-y-auto bg-white',
            !mobileShowDetail && addOnItems.length > 0 ? 'hidden md:block' : 'block',
          )}
        >
          {selectedItem && selectedIndex != null ? (
            <div className="p-4 sm:p-5">
              <button
                type="button"
                onClick={() => setMobileShowDetail(false)}
                className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand-primary md:hidden"
              >
                <ArrowLeft className="h-4 w-4" />
                All add-ons
              </button>
              <AddOnDetailPanel
                item={selectedItem}
                index={selectedIndex}
                total={addOnItems.length}
                uploading={uploadingIndex === selectedIndex}
                onChange={next => updateItemAt(selectedIndex, next)}
                onMove={dir => moveItem(selectedIndex, dir)}
                onRemove={() => removeItem(selectedIndex)}
                onImageUpload={file => handleImageUpload(selectedIndex, file)}
              />
            </div>
          ) : (
            <div className="flex h-full min-h-[280px] flex-col items-center justify-center px-6 py-12 text-center">
              <p className="text-sm font-medium text-gray-700">
                {addOnItems.length === 0 ? 'Add your first opportunity' : 'Select an add-on to edit'}
              </p>
              <p className="mt-1 max-w-sm text-xs text-gray-500">
                {addOnItems.length === 0
                  ? 'Browse the library to add Klaviyo products, ECD implementation packages, or ongoing management tiers.'
                  : 'Choose an item from the list on the left to edit pricing, copy, and visibility.'}
              </p>
              {addOnItems.length === 0 && availableTemplates.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  <Plus className="h-4 w-4" />
                  Browse library
                </button>
              ) : null}
            </div>
          )}
        </main>
      </div>

      <AddOpportunityPickerModal
        open={pickerOpen}
        templates={availableTemplates}
        onClose={() => setPickerOpen(false)}
        onSelect={addTemplate}
      />

      <AddOnHighlightRegenModal
        open={regenModalOpen}
        running={regenRunning}
        highlightedNames={highlightedNames}
        onConfirm={() => { void handleConfirmRegen(); }}
        onDismiss={() => { if (!regenRunning) setRegenModalOpen(false); }}
      />
    </div>
  );
}
