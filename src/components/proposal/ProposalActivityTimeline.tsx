import { useState } from 'react';
import { formatEventTime } from '../../lib/time-format';
import {
  FilePlus2,
  Send,
  Mail,
  Link2,
  Eye,
  PenLine,
  Trophy,
  XCircle,
  RotateCcw,
  PenSquare,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ProposalEvent, ProposalEventType } from '../../lib/types';

const EVENT_META: Record<ProposalEventType, { icon: LucideIcon; label: string; tone: string }> = {
  created: { icon: FilePlus2, label: 'Proposal created', tone: 'text-gray-400 bg-gray-50' },
  updated: { icon: PenSquare, label: 'Proposal updated', tone: 'text-gray-400 bg-gray-50' },
  sent: { icon: Send, label: 'Sent to client', tone: 'text-blue-600 bg-blue-50' },
  resent: { icon: Send, label: 'Resent to client', tone: 'text-blue-600 bg-blue-50' },
  viewed: { icon: Eye, label: 'Viewed by client', tone: 'text-purple-600 bg-purple-50' },
  signed: { icon: PenLine, label: 'Signed by client', tone: 'text-emerald-600 bg-emerald-50' },
  countersigned: { icon: PenLine, label: 'Countersigned by ECD', tone: 'text-emerald-600 bg-emerald-50' },
  won: { icon: Trophy, label: 'Marked won', tone: 'text-emerald-600 bg-emerald-50' },
  lost: { icon: XCircle, label: 'Marked lost', tone: 'text-red-600 bg-red-50' },
  reopened: { icon: RotateCcw, label: 'Reopened', tone: 'text-blue-600 bg-blue-50' },
};

// ---------------------------------------------------------------------------
// Send-method detection + email preview payload
//
// Two ways a proposal goes live: emailed via the send flow (metadata carries
// email_to / recipients / body_lines), or the public link was copied / made
// live manually (metadata.via === 'link'). Older events may only have a subset
// of fields, so we detect defensively and fall back gracefully.

type SendMethod = 'email' | 'link';

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function detectSendMethod(event: ProposalEvent): SendMethod | null {
  if (event.event_type !== 'sent' && event.event_type !== 'resent') return null;
  const m = event.metadata ?? {};
  if (m.send_method === 'email') return 'email';
  if (m.send_method === 'link' || m.via === 'link') return 'link';
  // Legacy fallback: emails always recorded email_to / email_results.
  if (m.email_to || m.email_results) return 'email';
  return 'link';
}

interface EmailPreview {
  subject: string | null;
  message: string | null;
  recipients: Array<{ name: string | null; email: string; status: string | null; reason: string | null }>;
  cc: string[];
  replyTo: string | null;
  bodyLines: string[];
  ctaLabel: string | null;
  status: string | null;
}

function buildEmailPreview(event: ProposalEvent): EmailPreview {
  const m = (event.metadata ?? {}) as Record<string, unknown>;

  const results = Array.isArray(m.email_results)
    ? (m.email_results as Array<Record<string, unknown>>)
    : [];
  const resultByEmail = new Map<string, Record<string, unknown>>();
  for (const r of results) {
    const email = asString(r.email);
    if (email) resultByEmail.set(email.toLowerCase(), r);
  }

  // Prefer the structured recipients array; fall back to the comma-joined email_to.
  let recipients: EmailPreview['recipients'] = [];
  if (Array.isArray(m.recipients)) {
    recipients = (m.recipients as Array<Record<string, unknown>>).map((r) => {
      const email = asString(r.email) ?? '';
      const res = resultByEmail.get(email.toLowerCase());
      return {
        name: asString(r.name),
        email,
        status: res ? asString(res.status) : null,
        reason: res ? asString(res.reason) : null,
      };
    });
  } else if (asString(m.email_to)) {
    recipients = (m.email_to as string)
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean)
      .map((email) => {
        const res = resultByEmail.get(email.toLowerCase());
        return {
          name: null,
          email,
          status: res ? asString(res.status) : null,
          reason: res ? asString(res.reason) : null,
        };
      });
  }

  // cc may be a stored array; older events kept only reply_to (as array or string).
  let cc: string[] = [];
  if (Array.isArray(m.cc)) {
    cc = (m.cc as unknown[]).map((c) => asString(c)).filter((c): c is string => !!c);
  } else if (Array.isArray(m.reply_to)) {
    // Legacy: reply_to array = [primary reply-to, ...cc].
    cc = (m.reply_to as unknown[]).slice(1).map((c) => asString(c)).filter((c): c is string => !!c);
  }

  const replyTo = asString(m.reply_to)
    ?? (Array.isArray(m.reply_to) ? asString((m.reply_to as unknown[])[0]) : null);

  const bodyLines = Array.isArray(m.body_lines)
    ? (m.body_lines as unknown[]).map((l) => asString(l)).filter((l): l is string => !!l)
    : [];

  return {
    subject: asString(m.subject),
    message: asString(m.message),
    recipients,
    cc,
    replyTo,
    bodyLines,
    ctaLabel: asString(m.cta_label),
    status: asString(m.email_status),
  };
}

function StatusPill({ status }: { status: string | null }) {
  if (!status) return null;
  const tone =
    status === 'sent'
      ? 'bg-emerald-50 text-emerald-700'
      : status === 'failed'
      ? 'bg-red-50 text-red-600'
      : 'bg-gray-100 text-gray-500';
  const label = status === 'sent' ? 'Delivered' : status === 'failed' ? 'Failed' : 'Skipped';
  return <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}>{label}</span>;
}

function EmailPreviewModal({ event, onClose }: { event: ProposalEvent; onClose: () => void }) {
  const preview = buildEmailPreview(event);
  const firstRecipientName = preview.recipients[0]?.name?.split(' ')[0] ?? null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Email preview"
      >
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-50 text-blue-600">
              <Mail className="h-3.5 w-3.5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-gray-900">
                {event.event_type === 'resent' ? 'Resent by email' : 'Emailed to client'}
              </p>
              <p className="text-[11px] text-gray-400">{formatEventTime(event.created_at)}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-gray-300 hover:text-gray-600" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4 text-sm">
          {/* Recipients */}
          <div className="flex gap-2">
            <span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-400">To</span>
            <div className="min-w-0 flex-1 space-y-1">
              {preview.recipients.length === 0 && <span className="text-gray-400">Not recorded</span>}
              {preview.recipients.map((r) => (
                <div key={r.email} className="flex flex-wrap items-center gap-1.5">
                  <span className="text-gray-800">
                    {r.name ? `${r.name} ` : ''}
                    <span className="text-gray-500">&lt;{r.email}&gt;</span>
                  </span>
                  <StatusPill status={r.status} />
                  {r.reason && <span className="text-[11px] text-red-500">{r.reason}</span>}
                </div>
              ))}
            </div>
          </div>

          {preview.cc.length > 0 && (
            <div className="flex gap-2">
              <span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Cc</span>
              <span className="min-w-0 flex-1 text-gray-700">{preview.cc.join(', ')}</span>
            </div>
          )}

          {preview.replyTo && (
            <div className="flex gap-2">
              <span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Reply-to</span>
              <span className="min-w-0 flex-1 text-gray-700">{preview.replyTo}</span>
            </div>
          )}

          {preview.subject && (
            <div className="flex gap-2">
              <span className="w-16 shrink-0 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Subject</span>
              <span className="min-w-0 flex-1 font-medium text-gray-900">{preview.subject}</span>
            </div>
          )}

          {/* Body */}
          <div className="mt-1 rounded-lg border border-gray-100 bg-gray-50 p-4">
            {preview.bodyLines.length > 0 || preview.message ? (
              <div className="space-y-2 text-sm leading-relaxed text-gray-700">
                <p>Hi{firstRecipientName ? ` ${firstRecipientName}` : ''},</p>
                {preview.bodyLines.map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
                {preview.ctaLabel && (
                  <p>
                    <span className="inline-block rounded-lg bg-brand-primary px-4 py-2 text-xs font-semibold text-white">
                      {preview.ctaLabel}
                    </span>
                  </p>
                )}
              </div>
            ) : (
              <p className="text-xs italic text-gray-400">
                The message body was not captured for this send.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ProposalActivityTimeline({ events }: { events: ProposalEvent[] }) {
  const [previewEvent, setPreviewEvent] = useState<ProposalEvent | null>(null);

  if (events.length === 0) {
    return <p className="text-xs text-gray-400">No activity yet.</p>;
  }

  return (
    <>
      <ol className="space-y-0">
        {events.map((event, index) => {
          const baseMeta = EVENT_META[event.event_type] ?? EVENT_META.updated;
          const sendMethod = detectSendMethod(event);
          // A "viewed" event by a staff actor is an internal ECD open, logged
          // without flipping the proposal to "viewed".
          const internalView = event.event_type === 'viewed' && event.actor === 'admin';

          // Resolve label + icon + tone, overriding for send methods / internal views.
          let label = baseMeta.label;
          let Icon = baseMeta.icon;
          let tone = baseMeta.tone;
          if (sendMethod === 'email') {
            label = event.event_type === 'resent' ? 'Resent by email' : 'Emailed to client';
            Icon = Mail;
          } else if (sendMethod === 'link') {
            label = event.event_type === 'resent' ? 'Link shared again' : 'Link shared';
            Icon = Link2;
          } else if (internalView) {
            label = `Viewed by ${event.actor_name ?? 'ECD team'}`;
            tone = 'text-gray-500 bg-gray-100';
          }

          const clickable = sendMethod === 'email';
          const reason = typeof event.metadata?.reason === 'string' ? event.metadata.reason : null;
          const ip = typeof event.metadata?.ip === 'string' && event.metadata.ip ? event.metadata.ip : null;
          const signerEmail =
            typeof event.metadata?.signer_email === 'string' && event.metadata.signer_email
              ? event.metadata.signer_email
              : null;
          // Name already appears in the internal-view label, so skip the "· by" suffix there.
          const actorName = event.actor === 'admin' && !internalView ? event.actor_name ?? null : null;
          const aiAssisted =
            (event.event_type === 'created' || event.event_type === 'updated') &&
            event.metadata?.via === 'ai_assistant';

          const methodHint =
            sendMethod === 'email'
              ? asString((event.metadata as Record<string, unknown>)?.email_to)
              : sendMethod === 'link'
              ? 'Public link copied'
              : null;

          return (
            <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
              {index < events.length - 1 && (
                <span className="absolute left-[13px] top-7 h-[calc(100%-1.25rem)] w-px bg-gray-100" aria-hidden />
              )}
              <span className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${tone}`}>
                <Icon className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 pt-1">
                <p className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-gray-800">
                  {clickable ? (
                    <button
                      type="button"
                      onClick={() => setPreviewEvent(event)}
                      className="font-medium text-blue-600 underline decoration-blue-200 underline-offset-2 hover:decoration-blue-500"
                    >
                      {label}
                    </button>
                  ) : (
                    label
                  )}
                  {aiAssisted && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-brand-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand-primary">
                      <Sparkles className="h-2.5 w-2.5" />
                      AI assisted
                    </span>
                  )}
                  {internalView && (
                    <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500">
                      Internal
                    </span>
                  )}
                  {actorName ? <span className="font-normal text-gray-400"> · by {actorName}</span> : null}
                </p>
                <p className="text-[11px] text-gray-400">{formatEventTime(event.created_at)}</p>
                {methodHint ? (
                  <p className="mt-0.5 truncate text-[11px] text-gray-400">{methodHint}</p>
                ) : null}
                {reason ? <p className="mt-0.5 text-[11px] italic text-gray-500">“{reason}”</p> : null}
                {(signerEmail || ip) && (
                  <p className="mt-0.5 text-[11px] text-gray-400">
                    {signerEmail ? signerEmail : null}
                    {signerEmail && ip ? ' · ' : null}
                    {ip ? `IP ${ip}` : null}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {previewEvent && <EmailPreviewModal event={previewEvent} onClose={() => setPreviewEvent(null)} />}
    </>
  );
}
