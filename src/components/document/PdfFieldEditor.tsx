import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, Copy, PenLine, Type, UserRound, X } from 'lucide-react';
import PdfPages from './PdfPages';
import { FIELD_LABEL, FIELD_SIZE, newFieldId, ROLE_LABEL } from '../../lib/pdf-docs';
import { cn } from '../../lib/utils';
import type { PdfField, PdfFieldRole, PdfFieldType } from '../../lib/types';

const ICON: Record<PdfFieldType, typeof PenLine> = { signature: PenLine, initials: Type, date: CalendarDays, name: UserRound };
const TONE: Record<PdfFieldRole, string> = {
  recipient: 'border-amber-500 bg-amber-100/70 text-amber-900',
  sender: 'border-indigo-500 bg-indigo-100/70 text-indigo-900',
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Places signing fields on an uploaded PDF (2026-11-18). Pick a field and who fills it, click a page to drop it,
 * drag to move, pull the corner to resize, x to remove. Positions are fractions of the page, so they stay put on
 * any screen and in the signed PDF. readOnly shows them without editing (a sent or signed document).
 */
export default function PdfFieldEditor({
  url,
  pages,
  fields,
  onChange,
  readOnly = false,
  senderAllowed = true,
}: {
  url: string;
  pages: number;
  fields: PdfField[];
  onChange: (next: PdfField[]) => void;
  readOnly?: boolean;
  /** False when the document carries no signature from us: only recipient fields then. */
  senderAllowed?: boolean;
}) {
  const [armed, setArmed] = useState<PdfFieldType | null>(null);
  const [role, setRole] = useState<PdfFieldRole>('recipient');
  const [selected, setSelected] = useState<string | null>(null);
  const [jump, setJump] = useState('');
  const latest = useRef(fields);
  latest.current = fields;

  useEffect(() => {
    if (!senderAllowed && role === 'sender') setRole('recipient');
  }, [senderAllowed, role]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setArmed(null);
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected && !readOnly) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        onChange(latest.current.filter(f => f.id !== selected));
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, readOnly, onChange]);

  const place = (page: number, e: React.MouseEvent<HTMLDivElement>) => {
    if (!armed || readOnly) {
      setSelected(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const { w, h } = FIELD_SIZE[armed];
    const x = clamp((e.clientX - rect.left) / rect.width - w / 2, 0, 1 - w);
    const y = clamp((e.clientY - rect.top) / rect.height - h / 2, 0, 1 - h);
    const field: PdfField = { id: newFieldId(), page, x, y, w, h, type: armed, role };
    onChange([...latest.current, field]);
    setSelected(field.id);
    setArmed(null);
  };

  const update = useCallback((id: string, patch: Partial<PdfField>) => {
    onChange(latest.current.map(f => (f.id === id ? { ...f, ...patch } : f)));
  }, [onChange]);

  const initialsEverywhere = () => {
    const { w, h } = FIELD_SIZE.initials;
    const have = new Set(latest.current.filter(f => f.type === 'initials' && f.role === 'recipient').map(f => f.page));
    const add: PdfField[] = [];
    for (let p = 1; p <= pages; p++) {
      if (!have.has(p)) add.push({ id: newFieldId(), page: p, x: 1 - w - 0.04, y: 1 - h - 0.03, w, h, type: 'initials', role: 'recipient' });
    }
    onChange([...latest.current, ...add]);
  };

  const goTo = () => {
    const n = Number(jump);
    if (n >= 1 && n <= pages) document.getElementById(`pdf-page-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const counts = {
    recipient: fields.filter(f => f.role === 'recipient').length,
    sender: fields.filter(f => f.role === 'sender').length,
  };
  const fieldPages = [...new Set(fields.map(f => f.page))].sort((a, b) => a - b);

  return (
    <div>
      <div className="sticky top-0 z-20 mb-3 rounded-xl border border-gray-200 bg-white/95 p-3 shadow-sm backdrop-blur print:hidden">
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-gray-200 p-0.5 text-xs font-medium">
              {(['recipient', 'sender'] as PdfFieldRole[]).map(r => (
                <button
                  key={r}
                  type="button"
                  disabled={r === 'sender' && !senderAllowed}
                  title={r === 'sender' && !senderAllowed ? 'Turn on "Include a signature from us" first' : undefined}
                  onClick={() => setRole(r)}
                  className={cn('rounded-md px-2.5 py-1', role === r ? (r === 'recipient' ? 'bg-amber-500 text-white' : 'bg-indigo-600 text-white') : 'text-gray-600 hover:text-gray-900 disabled:opacity-40')}
                >
                  {ROLE_LABEL[r]}
                </button>
              ))}
            </div>
            {(Object.keys(FIELD_LABEL) as PdfFieldType[]).map(t => {
              const Icon = ICON[t];
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setArmed(armed === t ? null : t)}
                  className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium', armed === t ? 'border-brand-primary bg-brand-primary text-white' : 'border-gray-200 text-gray-700 hover:bg-gray-50')}
                >
                  <Icon className="h-3.5 w-3.5" /> {FIELD_LABEL[t]}
                </button>
              );
            })}
            <button type="button" onClick={initialsEverywhere} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50" title="Recipient initials in the bottom-right corner of every page">
              <Copy className="h-3.5 w-3.5" /> Initials on every page
            </button>
          </div>
        )}
        <div className={cn('flex flex-wrap items-center gap-2 text-xs text-gray-500', !readOnly && 'mt-2')}>
          {armed && !readOnly ? (
            <span className="font-medium text-brand-primary">Click on a page to place the {FIELD_LABEL[armed].toLowerCase()} for {ROLE_LABEL[role].toLowerCase()}. Esc cancels.</span>
          ) : (
            <span>
              {counts.recipient} recipient field{counts.recipient === 1 ? '' : 's'}
              {counts.sender ? `, ${counts.sender} for us` : ''}
              {fieldPages.length ? ` on page${fieldPages.length === 1 ? '' : 's'} ${fieldPages.join(', ')}` : ''}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1">
            Page
            <input value={jump} onChange={e => setJump(e.target.value.replace(/\D/g, ''))} onKeyDown={e => e.key === 'Enter' && goTo()} placeholder="#" className="w-12 rounded border border-gray-200 px-1.5 py-0.5 text-center" />
            <span>of {pages}</span>
            <button type="button" onClick={goTo} className="rounded border border-gray-200 px-2 py-0.5 hover:bg-gray-50">Go</button>
          </span>
        </div>
      </div>

      <PdfPages
        url={url}
        renderOverlay={page => (
          <div className={cn('absolute inset-0', armed && !readOnly && 'cursor-crosshair')} onClick={e => place(page, e)}>
            {fields.filter(f => f.page === page).map(f => (
              <FieldBox key={f.id} field={f} selected={selected === f.id} readOnly={readOnly} onSelect={() => setSelected(f.id)} onChange={patch => update(f.id, patch)} onRemove={() => onChange(latest.current.filter(x => x.id !== f.id))} />
            ))}
          </div>
        )}
      />
    </div>
  );
}

function FieldBox({
  field: f,
  selected,
  readOnly,
  onSelect,
  onChange,
  onRemove,
}: {
  field: PdfField;
  selected: boolean;
  readOnly: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<PdfField>) => void;
  onRemove: () => void;
}) {
  const drag = (mode: 'move' | 'resize') => (e: React.PointerEvent) => {
    if (readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    onSelect();
    const page = (e.currentTarget as HTMLElement).closest('.absolute.inset-0') as HTMLElement | null;
    if (!page) return;
    const rect = page.getBoundingClientRect();
    const start = { px: e.clientX, py: e.clientY, x: f.x, y: f.y, w: f.w, h: f.h };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.px) / rect.width;
      const dy = (ev.clientY - start.py) / rect.height;
      if (mode === 'move') onChange({ x: clamp(start.x + dx, 0, 1 - start.w), y: clamp(start.y + dy, 0, 1 - start.h) });
      else onChange({ w: clamp(start.w + dx, 0.03, 1 - start.x), h: clamp(start.h + dy, 0.012, 1 - start.y) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const Icon = ICON[f.type];
  return (
    <div
      onClick={e => { e.stopPropagation(); onSelect(); }}
      onPointerDown={drag('move')}
      className={cn('absolute flex select-none items-center gap-1 overflow-hidden rounded border-2 border-dashed px-1 text-[10px] font-semibold leading-none', TONE[f.role], !readOnly && 'cursor-move', selected && 'ring-2 ring-brand-primary ring-offset-1')}
      style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{FIELD_LABEL[f.type]}{f.role === 'sender' ? ' (us)' : ''}</span>
      {!readOnly && selected && (
        <>
          <button type="button" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onRemove(); }} className="absolute right-0.5 top-0.5 rounded bg-white/90 p-0.5 text-gray-600 hover:text-red-600" aria-label="Remove field">
            <X className="h-3 w-3" />
          </button>
          <span onPointerDown={drag('resize')} className="absolute bottom-0 right-0 h-2.5 w-2.5 cursor-se-resize bg-brand-primary" />
        </>
      )}
    </div>
  );
}
