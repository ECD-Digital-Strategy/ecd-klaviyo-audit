import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2, Mail, RefreshCw, Send } from 'lucide-react';
import { welcomeAction } from '../../lib/invoice-sending';
import { useToast } from '../ui/Toast';
import type { Proposal, WelcomeEmailRecord } from '../../lib/types';

// The welcome email after signing (Xiomara 2026-11-03, Emil 2026-11-04): the
// invoice, launch call times, the forms and the intake form in one email from the
// sender's Gmail. It is built by supabase/functions/_shared/welcome-delivery.ts;
// this card shows where it is and, for a draft, lets the sender check, edit and
// send it. Only shown once the proposal has one (the feature is on in Proposal
// settings and the proposal was signed after that).

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

const PILL: Record<WelcomeEmailRecord['status'], { label: string; cls: string }> = {
  waiting: { label: 'Waiting', cls: 'bg-gray-100 text-gray-600' },
  sending: { label: 'Sending', cls: 'bg-brand-primary/10 text-brand-primary' },
  draft: { label: 'To review', cls: 'bg-amber-50 text-amber-700' },
  sent: { label: 'Sent', cls: 'bg-emerald-50 text-emerald-700' },
  skipped: { label: 'Not sent', cls: 'bg-gray-100 text-gray-500' },
};

export default function WelcomeEmailCard({ proposal, onChanged }: { proposal: Proposal; onChanged: () => void }) {
  const toast = useToast();
  const [rec, setRec] = useState<WelcomeEmailRecord | null>(proposal.welcome_email ?? null);
  const [subject, setSubject] = useState(rec?.subject ?? '');
  const [body, setBody] = useState(rec?.body ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setRec(proposal.welcome_email ?? null);
    setSubject(proposal.welcome_email?.subject ?? '');
    setBody(proposal.welcome_email?.body ?? '');
  }, [proposal.welcome_email]);

  if (!rec) return null;
  const edited = rec.status === 'draft' && (subject !== (rec.subject ?? '') || body !== (rec.body ?? ''));
  const pill = PILL[rec.status];

  const run = async (
    label: string,
    action: Parameters<typeof welcomeAction>[0],
    done: string,
    opts: { confirm?: string; edit?: boolean } = {},
  ) => {
    if (opts.confirm && !window.confirm(opts.confirm)) return;
    setBusy(label);
    try {
      const next = await welcomeAction(action, proposal.id, opts.edit ? { subject, body } : {});
      setRec(next);
      setSubject(next.subject ?? '');
      setBody(next.body ?? '');
      toast(done);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong');
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Mail className="h-3.5 w-3.5 text-gray-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Welcome email</h3>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${pill.cls}`}>{pill.label}</span>
      </div>

      {rec.status === 'waiting' && (
        <div className="mt-2 space-y-2 text-[11px] leading-relaxed text-gray-500">
          <p className="flex items-start gap-1.5">
            <Clock className="mt-0.5 h-3 w-3 shrink-0 text-gray-400" />
            Goes out with the invoice once everything it needs is there, checked every 15 minutes.
          </p>
          {rec.missing?.length ? (
            <ul className="space-y-1 pl-4">
              {rec.missing.map((m, i) => <li key={i} className="list-disc">{m}</li>)}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run('rebuild', 'welcome_rebuild', 'Drafted with what is there now')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              {busy === 'rebuild' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Draft it now
            </button>
            <SkipButton busy={busy} onSkip={() => run('skip', 'welcome_skip', 'Welcome email won’t be sent', { confirm: SKIP_CONFIRM })} />
          </div>
        </div>
      )}

      {rec.status === 'draft' && (
        <div className="mt-2 space-y-2">
          {rec.missing?.length ? (
            <div className="rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-800">
              <p className="flex items-center gap-1 font-semibold">
                <AlertTriangle className="h-3 w-3" /> Check before sending
              </p>
              <ul className="mt-1 space-y-0.5 pl-4">
                {rec.missing.map((m, i) => <li key={i} className="list-disc">{m}</li>)}
              </ul>
            </div>
          ) : (
            <p className="text-[11px] text-gray-500">Ready. Nothing has gone to the client yet.</p>
          )}
          {rec.error && <p className="text-[11px] text-red-600">Last try: {rec.error}</p>}
          <p className="text-[11px] text-gray-500">
            From <span className="font-medium text-gray-700">{rec.from_email ?? 'nobody connected'}</span> to{' '}
            <span className="font-medium text-gray-700">{rec.to ?? 'no client email'}</span>
            {rec.cc?.length ? `, copying ${rec.cc.join(', ')}` : ''}
            {rec.invoice_id ? ', invoice PDF attached' : ''}
          </p>
          {!open ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-left text-xs text-gray-700 hover:bg-gray-50"
            >
              <span className="block truncate font-medium">{rec.subject}</span>
              <span className="mt-0.5 block line-clamp-2 text-gray-400">{rec.body}</span>
              <span className="mt-1 block font-medium text-brand-primary">Review and edit</span>
            </button>
          ) : (
            <div className="space-y-2">
              <input
                value={subject}
                onChange={e => setSubject(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
              />
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                rows={16}
                className="w-full resize-y rounded-lg border border-gray-200 px-2.5 py-2 text-xs leading-relaxed focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
              />
              <p className="text-[10px] text-gray-400">Links show as words in the email (&quot;View and pay the invoice&quot;). Your Gmail signature is added underneath.</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={busy !== null || !rec.from_email || !rec.to}
              onClick={() => run('send', 'welcome_send', `Sent to ${rec.to}`, { confirm: `Send it to ${rec.to} now, from ${rec.from_email}?`, edit: true })}
              className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'send' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send
            </button>
            {edited && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run('save', 'welcome_save', 'Draft saved', { edit: true })}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
              </button>
            )}
            <button
              type="button"
              disabled={busy !== null}
              title="Build it again from what is there now: new launch call times, the intake form, the invoice. Your edits are replaced."
              onClick={() => run('rebuild', 'welcome_rebuild', 'Rebuilt with fresh times', edited ? { confirm: 'Rebuild it? Your edits will be replaced.' } : {})}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              {busy === 'rebuild' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Rebuild
            </button>
            <SkipButton busy={busy} onSkip={() => run('skip', 'welcome_skip', 'Welcome email won’t be sent', { confirm: SKIP_CONFIRM })} />
          </div>
        </div>
      )}

      {rec.status === 'sending' && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-gray-500">
          <Loader2 className="h-3 w-3 animate-spin" /> Sending now.
        </p>
      )}

      {rec.status === 'sent' && (
        <div className="mt-2 space-y-1.5 text-[11px] leading-relaxed">
          <p className="flex items-start gap-1.5 text-emerald-700">
            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
            Sent {when(rec.sent_at)} to {rec.to} from {rec.from_email}
            {rec.sent_by ? '' : ' automatically'}{rec.cc?.length ? `, ${rec.cc.join(', ')} copied` : ''}.
          </p>
          <details>
            <summary className="cursor-pointer text-gray-400 hover:text-gray-600">What it said</summary>
            <p className="mt-1 font-medium text-gray-700">{rec.subject}</p>
            <p className="mt-1 whitespace-pre-wrap text-gray-500">{rec.body}</p>
          </details>
        </div>
      )}

      {rec.status === 'skipped' && (
        <div className="mt-2 space-y-2 text-[11px] text-gray-500">
          <p>Not sent from here. The invoice can still be emailed from the Xero card.</p>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run('rebuild', 'welcome_rebuild', 'Drafted again')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            {busy === 'rebuild' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Draft it again
          </button>
        </div>
      )}
    </div>
  );
}

const SKIP_CONFIRM = "Don't send the welcome email from here? Use this if you're handling it by hand. You can draft it again later.";

function SkipButton({ busy, onSkip }: { busy: string | null; onSkip: () => void }) {
  return (
    <button
      type="button"
      disabled={busy !== null}
      onClick={onSkip}
      className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-400 hover:bg-gray-50 hover:text-gray-700 disabled:opacity-50"
    >
      {busy === 'skip' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Don't send"}
    </button>
  );
}
