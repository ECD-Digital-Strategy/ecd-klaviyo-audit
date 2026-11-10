import { useEffect, useState, type ReactNode } from 'react';
import { Mail, Maximize2, RefreshCw, X as XIcon, Palette } from 'lucide-react';
import AnnotationLayer from './AnnotationLayer';
import ClientEmailPickerModal from './ClientEmailPickerModal';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/select';
import type { Annotation, Audit, AuditEmailDesign, AuditSection, IndustryEmailLibrary } from '../../lib/types';
import {
  createAnnotation,
  deleteAnnotation,
  getPlatformSettings,
  upsertAuditEmailDesign,
} from '../../lib/db';

export default function EmailDesignEditor({
  audit,
  emailDesign,
  emailLibrary,
  annotations,
  section,
  onAnnotationsChange,
  onEmailDesignChange,
}: {
  audit: Audit;
  emailDesign: AuditEmailDesign | null;
  emailLibrary: IndustryEmailLibrary[];
  annotations: Annotation[];
  section: AuditSection | null;
  onAnnotationsChange: (anns: Annotation[]) => void;
  onEmailDesignChange: (ed: AuditEmailDesign | null) => void;
}) {
  const [selectedEcdId, setSelectedEcdId] = useState(emailDesign?.ecd_example_id || '');
  const [saving, setSaving] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [globalAnnotationSize, setGlobalAnnotationSize] = useState<'sm' | 'md' | 'lg'>('md');
  const [globalAnnotationsExpanded, setGlobalAnnotationsExpanded] = useState(false);
  const [clientEmailPickerOpen, setClientEmailPickerOpen] = useState(false);

  useEffect(() => {
    setSelectedEcdId(emailDesign?.ecd_example_id || '');
  }, [emailDesign?.ecd_example_id]);

  useEffect(() => {
    getPlatformSettings().then(s => {
      setGlobalAnnotationSize(s.annotation_size);
      setGlobalAnnotationsExpanded(s.annotations_expanded);
    }).catch(() => {});
  }, []);

  const ecdExample = emailDesign?.ecd_example || emailLibrary.find(e => e.id === selectedEcdId) || null;
  const sectionAnns = section ? annotations.filter(a => a.audit_section_id === section.id) : [];

  const handleSelectEcd = async (newId: string) => {
    setSelectedEcdId(newId);
    if (!section) return;
    try {
      setSaving(true);
      const updated = await upsertAuditEmailDesign(audit.id, { ecd_example_id: newId || null });
      onEmailDesignChange(updated);

      const oldOptimized = annotations.filter(a => a.audit_section_id === section.id && a.side === 'optimized');
      for (const old of oldOptimized) {
        try { await deleteAnnotation(old.id); } catch { /* ignore */ }
      }
      let updatedAnns = annotations.filter(a => !(a.audit_section_id === section.id && a.side === 'optimized'));

      const libEntry = emailLibrary.find(e => e.id === newId);
      if (libEntry?.default_annotations?.length) {
        for (const ann of libEntry.default_annotations) {
          try {
            const created = await createAnnotation({
              audit_section_id: section.id,
              asset_id: null,
              x_position: ann.x,
              y_position: ann.y,
              label: ann.label,
              side: 'optimized',
            });
            updatedAnns = [...updatedAnns, created];
          } catch (e) {
            console.error('Failed to copy library annotation:', e);
          }
        }
      }
      onAnnotationsChange(updatedAnns);
    } catch { /* ignore */ } finally {
      setSaving(false);
    }
  };

  const handleAddAnnotation = async (side: 'current' | 'optimized', x: number, y: number, label: string) => {
    if (!section) return;
    try {
      const created = await createAnnotation({
        audit_section_id: section.id,
        asset_id: null,
        x_position: x,
        y_position: y,
        label,
        side,
      });
      onAnnotationsChange([...annotations, created]);
    } catch (e) {
      console.error('Failed to save annotation:', e);
    }
  };

  const handleRemoveAnnotation = async (annId: string) => {
    onAnnotationsChange(annotations.filter(a => a.id !== annId));
    try {
      await deleteAnnotation(annId);
    } catch { /* ignore */ }
  };

  const handleClientEmailSelected = async (updated: AuditEmailDesign) => {
    if (!section) {
      onEmailDesignChange(updated);
      return;
    }
    const currentSide = annotations.filter(
      a => a.audit_section_id === section.id && a.side === 'current',
    );
    for (const ann of currentSide) {
      try {
        await deleteAnnotation(ann.id);
      } catch { /* ignore */ }
    }
    const updatedAnns = annotations.filter(
      a => !(a.audit_section_id === section.id && a.side === 'current'),
    );
    onAnnotationsChange(updatedAnns);
    onEmailDesignChange(updated);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Email Design Comparison</h2>
        <p className="text-sm text-gray-500 mb-4">
          Side-by-side comparison of the client&apos;s email and an ECD benchmark. Click on each email to annotate strengths and weaknesses.
        </p>

        {emailLibrary.length > 0 && (
          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-1">ECD Benchmark Example</label>
            <Select value={selectedEcdId || '__none__'} onValueChange={v => handleSelectEcd(v === '__none__' ? '' : v)} disabled={saving}>
              <SelectTrigger className="w-full max-w-sm">
                <SelectValue placeholder="Select an example..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__"><SelectItemText>Select an example...</SelectItemText></SelectItem>
                {emailLibrary.map(e => (
                  <SelectItem key={e.id} value={e.id}><SelectItemText>{e.name} ({e.industry})</SelectItemText></SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex justify-end mb-3">
          <button
            type="button"
            onClick={() => setFullscreen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-brand-primary bg-brand-primary/5 rounded-lg hover:bg-brand-primary/10 transition-colors"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            Full-screen compare
          </button>
        </div>

        <EmailDesignGrid
          emailDesign={emailDesign}
          ecdExample={ecdExample}
          sectionAnns={sectionAnns}
          handleAddAnnotation={handleAddAnnotation}
          handleRemoveAnnotation={handleRemoveAnnotation}
          markerSize={globalAnnotationSize}
          alwaysShowLabels={globalAnnotationsExpanded}
          onChangeClientEmail={() => setClientEmailPickerOpen(true)}
        />
      </div>

      <ClientEmailPickerModal
        open={clientEmailPickerOpen}
        auditId={audit.id}
        currentCampaignId={emailDesign?.client_campaign_id ?? null}
        onClose={() => setClientEmailPickerOpen(false)}
        onSelected={ed => void handleClientEmailSelected(ed)}
      />

      {fullscreen && (
        <div className="fixed inset-0 z-[60] bg-[#f7f7f8] overflow-y-auto">
          <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-3 bg-white/95 backdrop-blur border-b border-gray-100">
            <h3 className="text-sm font-semibold text-gray-900">Email Design Comparison</h3>
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
            >
              <XIcon className="w-3.5 h-3.5" />
              Close
            </button>
          </div>
          <div className="p-6 pb-24 max-w-screen-2xl mx-auto">
            <div className="bg-white rounded-xl card-shadow p-6">
              <EmailDesignGrid
                emailDesign={emailDesign}
                ecdExample={ecdExample}
                sectionAnns={sectionAnns}
                handleAddAnnotation={handleAddAnnotation}
                handleRemoveAnnotation={handleRemoveAnnotation}
                maxHeight={typeof window !== 'undefined' ? window.innerHeight - 120 : 900}
                markerSize={globalAnnotationSize}
                alwaysShowLabels={globalAnnotationsExpanded}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function EmailDesignDrawer({
  open,
  onClose,
  title = 'Email design & benchmark',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-black/30"
        aria-label="Close email design editor"
        onClick={onClose}
      />
      <div className="relative flex h-full w-full max-w-6xl flex-col bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-gray-100 px-5 py-3">
          <h3 className="min-w-0 truncate text-sm font-semibold text-gray-900">{title}</h3>
          <div className="flex shrink-0 items-center gap-4">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"
            >
              <XIcon className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-5 sm:p-6">{children}</div>
      </div>
    </div>
  );
}

function EmailDesignGrid({
  emailDesign,
  ecdExample,
  sectionAnns,
  handleAddAnnotation,
  handleRemoveAnnotation,
  maxHeight,
  markerSize = 'md',
  alwaysShowLabels = false,
  onChangeClientEmail,
}: {
  emailDesign: AuditEmailDesign | null;
  ecdExample: IndustryEmailLibrary | null;
  sectionAnns: Annotation[];
  handleAddAnnotation: (side: 'current' | 'optimized', x: number, y: number, label: string) => void;
  handleRemoveAnnotation: (id: string) => void;
  maxHeight?: number;
  markerSize?: 'sm' | 'md' | 'lg';
  alwaysShowLabels?: boolean;
  onChangeClientEmail?: () => void;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_1px_1fr] gap-0">
      <div className="min-w-0 space-y-3 px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
            <h4 className="text-sm font-semibold text-gray-800 truncate">
              Client&apos;s Email
              {emailDesign?.client_campaign_name && (
                <span className="ml-1 text-xs font-normal text-gray-400">
                  ({emailDesign.client_campaign_name})
                </span>
              )}
            </h4>
          </div>
          {onChangeClientEmail && (
            <button
              type="button"
              onClick={onChangeClientEmail}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              <RefreshCw className="h-3 w-3" />
              Change client email
            </button>
          )}
        </div>
        {emailDesign?.client_email_html ? (
          <AnnotationLayer
            htmlContent={emailDesign.client_email_html}
            annotations={sectionAnns}
            onAddAnnotation={(x, y, label) => handleAddAnnotation('current', x, y, label)}
            onRemoveAnnotation={handleRemoveAnnotation}
            editable
            side="current"
            markerSize={markerSize}
            alwaysShowLabels={alwaysShowLabels}
            {...(maxHeight ? { maxHeight } : {})}
          />
        ) : (
          <div className="aspect-[9/16] max-h-[600px] bg-gray-50 rounded-lg border-2 border-dashed border-gray-200 flex items-center justify-center">
            <div className="text-center">
              <Mail className="w-8 h-8 text-gray-200 mx-auto mb-2" />
              <p className="text-sm text-gray-400">No client email fetched</p>
              <p className="text-xs text-gray-300 mt-1">The client&apos;s most recent campaign email will appear here after running the audit</p>
            </div>
          </div>
        )}
      </div>

      <div className="hidden lg:block bg-gray-200 w-px" />

      <div className="min-w-0 space-y-3 px-4">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500" />
          <h4 className="text-sm font-semibold text-gray-800">ECD Benchmark</h4>
        </div>
        {ecdExample ? (
          <AnnotationLayer
            imageUrl={ecdExample.content_type === 'image' ? (ecdExample.image_url ?? undefined) : undefined}
            htmlContent={ecdExample.content_type === 'html' ? (ecdExample.html_content ?? undefined) : undefined}
            annotations={sectionAnns}
            onAddAnnotation={(x, y, label) => handleAddAnnotation('optimized', x, y, label)}
            onRemoveAnnotation={handleRemoveAnnotation}
            editable
            side="optimized"
            markerSize={markerSize}
            alwaysShowLabels={alwaysShowLabels}
            {...(maxHeight ? { maxHeight } : {})}
          />
        ) : (
          <div className="aspect-[9/16] max-h-[600px] bg-gray-50 rounded-lg border-2 border-dashed border-gray-200 flex items-center justify-center px-6">
            <div className="text-center">
              <Palette className="w-8 h-8 text-gray-200 mx-auto mb-2" />
              <p className="text-sm text-gray-400">No benchmark selected</p>
              <p className="text-xs text-gray-300 mt-1">Select an ECD example above or add one in Admin &gt; Email Library</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
