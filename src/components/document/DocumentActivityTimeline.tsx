import { useState } from 'react';
import { formatEventTime } from '../../lib/time-format';
import { FilePlus2, PenSquare, Send, Mail, Link2, Eye, PenLine, Ban, RotateCcw, Sparkles, X, type LucideIcon } from 'lucide-react';
import type { DocumentEvent, DocumentEventType } from '../../lib/types';

const EVENT_META: Record<DocumentEventType, { icon: LucideIcon; label: string; tone: string }> = {
  created: { icon: FilePlus2, label: 'Document created', tone: 'text-gray-400 bg-gray-50' },
  updated: { icon: PenSquare, label: 'Document updated', tone: 'text-gray-400 bg-gray-50' },
  sent: { icon: Send, label: 'Sent to recipient', tone: 'text-blue-600 bg-blue-50' },
  resent: { icon: Send, label: 'Resent to recipient', tone: 'text-blue-600 bg-blue-50' },
  viewed: { icon: Eye, label: 'Viewed by recipient', tone: 'text-purple-600 bg-purple-50' },
  signed: { icon: PenLine, label: 'Signed by recipient', tone: 'text-emerald-600 bg-emerald-50' },
  void: { icon: Ban, label: 'Voided', tone: 'text-red-600 bg-red-50' },
  reopened: { icon: RotateCcw, label: 'Reopened', tone: 'text-blue-600 bg-blue-50' },
};

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function detectEmailSend(event: DocumentEvent): boolean {
  if (event.event_type !== 'sent' && event.event_type !== 'resent') return false;
  const m = event.metadata ?? {};
  if (m.send_method === 'email') return true;
  if (m.send_method === 'link') return false;
  return Boolean(m.email_to);
}

function EmailPreviewModal({ event, onClose }: { event: DocumentEvent; onClose: () => void }) {
  const m = (event.metadata ?? {}) as Record<string, unknown>;
  const recipient = (m.recipient ?? {}) as { name?: string | null; email?: string | null };
  const cc = Array.isArray(m.cc) ? (m.cc as unknown[]).map(asString).filter((c): c is string => !!c) : [];
  const bodyLines = Array.isArray(m.body_lines) ? (m.body_lines as unknown[]).map(asString).filter((l): l is string => !!l) : [];
  const firstName = recipient.name?.split(' ')[0] ?? null;
  const status = asString(m.email_status);
  const emailError = asString(m.email_error);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose} role="presentation">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-xl" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-50 text-blue-600"><Mail className="h-3.5 w-3.5" /></span>
            <div>
              <p className="text-sm font-semibold text-gray-900">{event.event_type === 'resent' ? 'Resent by email' : 'Emailed to recipient'}</p>
              <p className="text-[11px] text-gray-400">{formatEventTime(event.created_at)}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-gray-300 hover:text-gray-600" aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3 px-5 py-4 text-sm">
          <div className="flex gap-2">
            <span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-400">To</span>
            <span className="min-w-0 flex-1 text-gray-800">
              {recipient.name ? `${recipient.name} ` : ''}<span className="text-gray-500">&lt;{recipient.email ?? asString(m.email_to) ?? 'unknown'}&gt;</span>
              {status && <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${status === 'sent' ? 'bg-emerald-50 text-emerald-700' : status === 'failed' ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-500'}`}>{status === 'sent' ? 'Delivered' : status === 'failed' ? 'Failed' : 'Skipped'}</span>}
            </span>
          </div>
          {emailError && (status === 'failed' || status === 'skipped') && (
            <div className="flex gap-2">
              <span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Reason</span>
              <span className={`min-w-0 flex-1 text-xs ${status === 'failed' ? 'text-red-600' : 'text-gray-500'}`}>{emailError}</span>
            </div>
          )}
          {cc.length > 0 && <div className="flex gap-2"><span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Cc</span><span className="min-w-0 flex-1 text-gray-700">{cc.join(', ')}</span></div>}
          {asString(m.reply_to) && <div className="flex gap-2"><span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Reply-to</span><span className="min-w-0 flex-1 text-gray-700">{asString(m.reply_to)}</span></div>}
          {asString(m.subject) && <div className="flex gap-2"><span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Subject</span><span className="min-w-0 flex-1 font-medium text-gray-900">{asString(m.subject)}</span></div>}
          <div className="mt-1 rounded-lg border border-gray-100 bg-gray-50 p-4">
            {bodyLines.length > 0 ? (
              <div className="space-y-2 text-sm leading-relaxed text-gray-700">
                <p>Hi{firstName ? ` ${firstName}` : ''},</p>
                {bodyLines.map((line, i) => <p key={i}>{line}</p>)}
                {asString(m.cta_label) && <p><span className="inline-block rounded-lg bg-brand-primary px-4 py-2 text-xs font-semibold text-white">{asString(m.cta_label)}</span></p>}
              </div>
            ) : (
              <p className="text-xs italic text-gray-400">The message body was not captured for this send.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DocumentActivityTimeline({ events }: { events: DocumentEvent[] }) {
  const [previewEvent, setPreviewEvent] = useState<DocumentEvent | null>(null);
  if (events.length === 0) return <p className="text-xs text-gray-400">No activity yet.</p>;

  return (
    <>
      <ol className="space-y-0">
        {events.map((event, index) => {
          const base = EVENT_META[event.event_type] ?? EVENT_META.updated;
          const internalView = event.event_type === 'viewed' && event.actor === 'admin';
          const emailSend = detectEmailSend(event);
          const linkSend = (event.event_type === 'sent' || event.event_type === 'resent') && !emailSend;
          let label = base.label;
          let Icon = base.icon;
          let tone = base.tone;
          const senderSigned = event.event_type === 'signed' && (event.metadata as { role?: string })?.role === 'sender';
          if (emailSend) { label = event.event_type === 'resent' ? 'Resent by email' : 'Emailed to recipient'; Icon = Mail; }
          else if (linkSend) { label = event.event_type === 'resent' ? 'Link shared again' : 'Link shared'; Icon = Link2; }
          else if (internalView) { label = `Viewed by ${event.actor_name ?? 'ECD team'}`; tone = 'text-gray-500 bg-gray-100'; }
          else if (senderSigned) { label = 'Countersigned'; }

          const clickable = emailSend;
          const emailStatus = emailSend ? asString((event.metadata as Record<string, unknown> | null)?.email_status) : null;
          const actorName = event.actor === 'admin' && !internalView ? event.actor_name ?? null : null;
          const aiAssisted = (event.event_type === 'created' || event.event_type === 'updated') && event.metadata?.via === 'ai_assistant';
          const signerEmail = typeof event.metadata?.signer_email === 'string' ? event.metadata.signer_email : null;

          return (
            <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
              {index < events.length - 1 && <span className="absolute left-[13px] top-7 h-[calc(100%-1.25rem)] w-px bg-gray-100" aria-hidden />}
              <span className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${tone}`}><Icon className="h-3.5 w-3.5" /></span>
              <div className="min-w-0 pt-1">
                <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-gray-800">
                  {clickable ? (
                    <button type="button" onClick={() => setPreviewEvent(event)} className="font-medium text-blue-600 underline decoration-blue-200 underline-offset-2 hover:decoration-blue-500">{label}</button>
                  ) : label}
                  {(emailStatus === 'failed' || emailStatus === 'skipped') && <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${emailStatus === 'failed' ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-500'}`}>{emailStatus === 'failed' ? 'Failed' : 'Skipped'}</span>}
                  {aiAssisted && <span className="inline-flex items-center gap-1 rounded-full bg-brand-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand-primary"><Sparkles className="h-2.5 w-2.5" /> AI assisted</span>}
                  {internalView && <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500">Internal</span>}
                  {actorName ? <span className="font-normal text-gray-400"> · by {actorName}</span> : null}
                </p>
                <p className="text-[11px] text-gray-400">{formatEventTime(event.created_at)}</p>
                {signerEmail && <p className="mt-0.5 text-[11px] text-gray-400">{signerEmail}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      {previewEvent && <EmailPreviewModal event={previewEvent} onClose={() => setPreviewEvent(null)} />}
    </>
  );
}
