import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Copy, Loader2, Mail, Receipt } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import {
  connectGmail,
  disconnectGmail,
  getGmailStatus,
  listInvoiceSenders,
  saveGoogleClient,
  sendGmailTest,
  type GmailStatus,
  type InvoiceSender,
} from '../../lib/invoice-sending';
import type { InvoicingSettings } from '../../lib/types';

// Proposal settings: invoices emailed to the client from a person's own Gmail
// (Emil + Isa, 2026-11-02; see src/lib/invoice-sending.ts). Everyone who may send
// invoices connects their Gmail here. The two switches stay off until the team
// turns them on; the rest is saved with the panel's Save settings.

const PLACEHOLDERS = '{first_name} {company} {proposal_title} {invoice_number} {total} {due_date} {pay_link} {sender_first_name}';

export default function InvoiceEmailSettings({
  value,
  onChange,
  inputClass,
}: {
  value: InvoicingSettings;
  onChange: (next: InvoicingSettings) => void;
  inputClass: string;
}) {
  const toast = useToast();
  const { hasRole } = useAuth();
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [senders, setSenders] = useState<InvoiceSender[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [ccRaw, setCcRaw] = useState(value.cc_emails.join(', '));

  const load = useCallback(async () => {
    const [s, list] = await Promise.all([getGmailStatus().catch(() => null), listInvoiceSenders().catch(() => [])]);
    setStatus(s);
    setSenders(list);
  }, []);

  useEffect(() => {
    void load();
    // Back from Google sign-in: say how it went, then tidy the address bar.
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('gmail');
    if (outcome) {
      toast(outcome === 'connected' ? `Gmail connected: ${params.get('gmail_email') ?? ''}` : `Gmail not connected: ${params.get('gmail_detail') ?? 'unknown error'}`);
      ['gmail', 'gmail_email', 'gmail_detail'].forEach(k => params.delete(k));
      const qs = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
  }, [load, toast]);

  const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    try {
      await fn();
      await load();
      if (done) toast(done);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const set = (patch: Partial<InvoicingSettings>) => onChange({ ...value, ...patch });
  const isAdmin = hasRole('admin');

  return (
    <section className="rounded-xl bg-white card-shadow overflow-hidden">
      <div className="flex items-center gap-3 border-b border-gray-100 bg-gray-50/60 px-5 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-brand-primary">
          <Receipt className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-gray-900">Invoice emails</h3>
          <p className="text-xs text-gray-500">
            When a client signs, their implementation invoice is emailed to them from the Gmail of whoever is picked on the
            proposal, with the PDF and the pay link. Monthly invoices stay drafts in Xero.
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${value.auto_send ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
          {value.auto_send ? 'On' : 'Off'}
        </span>
      </div>

      <div className="space-y-6 p-5">
        {/* My Gmail */}
        <div>
          <p className="mb-1 text-xs font-medium text-gray-500">Your Gmail</p>
          {status === null ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : status.mine ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <span className="text-gray-800">Connected as <span className="font-medium">{status.mine.email}</span></span>
              {status.mine.last_error && <span className="text-xs text-amber-700">Last problem: {status.mine.last_error}</span>}
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run('test', sendGmailTest, 'Test sent to your inbox')}
                className="ml-2 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {busy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />} Send me a test
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => { if (window.confirm('Disconnect your Gmail? Invoices picked to come from you will go to you to forward instead.')) void run('disconnect', disconnectGmail, 'Gmail disconnected'); }}
                className="text-xs text-gray-400 hover:text-gray-700"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={busy !== null || !status.configured}
                onClick={() => run('connect', connectGmail)}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
              >
                {busy === 'connect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />} Connect Gmail
              </button>
              <p className="text-[11px] text-gray-400">
                {status.configured
                  ? 'Sign in with your ECD Google account. It can only send email, never read it.'
                  : 'Google sign-in is not set up yet (an admin does it below).'}
              </p>
            </div>
          )}
          {senders.length > 0 && (
            <p className="mt-2 text-[11px] text-gray-400">Connected: {senders.map(s => s.name).join(', ')}.</p>
          )}
        </div>

        {/* Switches and wording */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex items-start gap-2 text-sm text-gray-800 sm:col-span-2">
            <input type="checkbox" checked={value.auto_send} onChange={e => set({ auto_send: e.target.checked })} className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-primary" />
            <span>
              Email the implementation invoice to the client when they sign
              <span className="block text-xs text-gray-500">
                From the Gmail of the proposal&apos;s &quot;Invoice sent by&quot; (its sender by default). If that Gmail isn&apos;t connected,
                the payment link goes to the sender to forward, as now.
              </span>
            </span>
          </label>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium text-gray-500">Always copy</label>
            <input
              type="text"
              value={ccRaw}
              onChange={e => setCcRaw(e.target.value)}
              onBlur={() => set({ cc_emails: ccRaw.split(/[,;\s]+/).map(s => s.trim()).filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) })}
              placeholder="maria@ecdigitalstrategy.com"
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-gray-400">Copied on every invoice email and every unpaid reminder. Comma-separated.</p>
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium text-gray-500">Subject</label>
            <input type="text" value={value.subject} onChange={e => set({ subject: e.target.value })} className={inputClass} />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium text-gray-500">Email</label>
            <textarea value={value.body} onChange={e => set({ body: e.target.value })} rows={9} className={`${inputClass} max-w-2xl`} />
            <p className="mt-1 text-[11px] text-gray-400">Fills in: {PLACEHOLDERS}. The sender&apos;s Gmail signature is not added, so sign off in the text.</p>
          </div>
          <label className="flex items-start gap-2 text-sm text-gray-800 sm:col-span-2">
            <input
              type="checkbox"
              checked={value.overdue_nudges}
              onChange={e => set({
                overdue_nudges: e.target.checked,
                // Only invoices from now on: switching it on never sends a pile of reminders about old ones.
                nudges_since: e.target.checked ? (value.nudges_since ?? new Date().toISOString().slice(0, 10)) : value.nudges_since,
              })}
              className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand-primary"
            />
            <span>
              Remind the team about unpaid invoices
              <span className="block text-xs text-gray-500">
                Checks Xero daily. Emails the people copied above and the invoice&apos;s sender when it is overdue, then weekly until paid.
                {value.nudges_since ? ` Invoices from ${new Date(`${value.nudges_since}T12:00:00`).toLocaleDateString()} on.` : ''}
              </span>
            </span>
          </label>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">First reminder, days after the due date</label>
            <input
              type="number"
              min={1}
              max={60}
              value={value.nudge_after_days}
              onChange={e => set({ nudge_after_days: Math.max(1, Math.min(60, Number(e.target.value) || 7)) })}
              className={inputClass}
            />
          </div>
        </div>

        {/* Google app, admins only */}
        {isAdmin && status && (
          <div className="rounded-lg border border-gray-100 bg-gray-50/60 p-4">
            <p className="text-xs font-semibold text-gray-700">Google sign-in {status.configured ? '(set up)' : '(not set up)'}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-gray-500">
              A Google Cloud OAuth client (Web application) in the ECD Workspace, with the Gmail API on and the consent screen set to
              Internal. Add this as an authorised redirect URI:
            </p>
            <div className="mt-1.5 flex items-center gap-2">
              <code className="truncate rounded bg-white px-2 py-1 text-[11px] text-gray-700">{status.redirect_uri}</code>
              <button
                type="button"
                onClick={() => { void navigator.clipboard.writeText(status.redirect_uri); toast('Copied'); }}
                className="shrink-0 text-gray-400 hover:text-gray-700"
                title="Copy"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
            <form
              className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
              onSubmit={e => {
                e.preventDefault();
                void run('client', async () => { await saveGoogleClient(clientId, clientSecret); setClientId(''); setClientSecret(''); }, 'Google sign-in saved');
              }}
            >
              <input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="Client ID" className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm" />
              <input value={clientSecret} onChange={e => setClientSecret(e.target.value)} type="password" autoComplete="off" placeholder="Client secret" className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm" />
              <button type="submit" disabled={busy !== null || !clientId.trim() || !clientSecret.trim()} className="rounded-lg gradient-bg px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50">
                {busy === 'client' ? 'Saving…' : status.configured ? 'Replace' : 'Save'}
              </button>
            </form>
            <p className="mt-1 text-[11px] text-gray-400">Stored encrypted; never shown again.</p>
          </div>
        )}
      </div>
    </section>
  );
}
