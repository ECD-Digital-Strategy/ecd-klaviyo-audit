import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BellRing, CheckCircle2, KeyRound, Loader2, Mail, Plus, Receipt, Send } from 'lucide-react';
import { useToast } from '../ui/Toast';
import SettingsCard from '../ui/SettingsCard';
import ToggleSwitch, { ToggleRow } from '../ui/ToggleSwitch';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/select';
import {
  connectGmail,
  disconnectGmail,
  getGmailStatus,
  sendGmailTest,
  signatureNote,
  type GmailConnection,
  type GmailStatus,
} from '../../lib/invoice-sending';
import type { InvoicingSettings } from '../../lib/types';

// Proposal settings: invoices emailed to the client from a person's own Gmail
// (Emil + Isa, 2026-11-02; see src/lib/invoice-sending.ts). Everyone who may send
// invoices connects their Gmail here, and the list shows who has. The two
// switches stay off until the team turns them on; the rest is saved with the
// panel's Save settings. Redesigned 2026-11-02: branded switches, a clear list of
// connected people, and an obvious "set up" state for Google sign-in.

const PLACEHOLDERS = ['first_name', 'company', 'proposal_title', 'invoice_number', 'total', 'due_date', 'pay_link', 'sender_first_name'];

const parseEmails = (raw: string) =>
  raw.split(/[,;\s]+/).map(e => e.trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

const shortDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null;

const initials = (name: string) =>
  name.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(s => s[0]!.toUpperCase()).join('') || '?';

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
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [ccRaw, setCcRaw] = useState(value.cc_emails.join(', '));
  const [remindRaw, setRemindRaw] = useState(value.reminder_emails.join(', '));

  const load = useCallback(async () => {
    try {
      setStatus(await getGmailStatus());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Back from Google sign-in: say how it went, once, then tidy the address bar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('gmail');
    if (!outcome) return;
    toast(outcome === 'connected' ? `Gmail connected: ${params.get('gmail_email') ?? ''}` : `Gmail not connected: ${params.get('gmail_detail') ?? 'unknown error'}`);
    ['gmail', 'gmail_email', 'gmail_detail'].forEach(k => params.delete(k));
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  // The panel's inputs are max-w-md; these read better full width.
  const wide = inputClass.replace('max-w-md', 'max-w-3xl');
  // The fallback can be anyone connected, plus whatever is saved (even if not connected yet).
  const fallbackConnected = Boolean(status?.connections.some(c => c.email.toLowerCase() === value.fallback_sender_email));
  const fallbackOptions = [
    ...(status?.connections ?? []).map(c => ({ email: c.email.toLowerCase(), label: `${c.name} (${c.email})` })),
    ...(fallbackConnected || !value.fallback_sender_email ? [] : [{ email: value.fallback_sender_email, label: `${value.fallback_sender_email} (not connected)` }]),
  ];

  return (
    <SettingsCard
      icon={<Receipt className="h-4 w-4" />}
      title="Invoice emails"
      description="When a client signs, their implementation invoice is emailed to them from the Gmail of whoever is picked on the proposal, with the PDF and the pay link. Monthly invoices stay drafts in Xero."
      control={
        <>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${value.auto_send ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
            {value.auto_send ? 'Sending on' : 'Sending off'}
          </span>
          <ToggleSwitch
            checked={value.auto_send}
            onChange={v => set({ auto_send: v })}
            aria-label="Email the invoice to the client when they sign"
          />
        </>
      }
      collapsible
      defaultOpen
      storageKey="settings_open_proposal_invoices"
    >

      <div className="divide-y divide-gray-100">
        {/* 1. Who can send */}
        <div className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h4 className="text-sm font-semibold text-gray-900">Connected Gmail accounts</h4>
              <p className="mt-0.5 text-xs text-gray-500">
                Invoices can come from anyone here. Each proposal picks one under &quot;Invoice sent by&quot;. Connecting only allows
                sending, never reading mail.
              </p>
            </div>
            {status?.configured && !status.mine && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run('connect', connectGmail)}
                className="inline-flex shrink-0 items-center gap-2 rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy === 'connect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Connect my Gmail
              </button>
            )}
          </div>

          <div className="mt-4">
            {status === null ? (
              loadFailed ? (
                <p className="text-sm text-red-600">
                  Could not load the connected accounts.{' '}
                  <button type="button" onClick={() => void load()} className="font-medium underline">Try again</button>
                </p>
              ) : (
                <div className="space-y-2">
                  {[0, 1].map(i => <div key={i} className="h-14 animate-pulse rounded-lg bg-gray-50" />)}
                </div>
              )
            ) : !status.configured ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-gray-200 px-4 py-3 text-sm text-gray-500">
                <KeyRound className="h-4 w-4 text-gray-400" />
                Google sign-in isn&apos;t set up yet{status.is_admin ? '. Add it under Settings, API Connection.' : '. An admin needs to add it first.'}
              </div>
            ) : status.connections.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-200 px-4 py-6 text-center">
                <Mail className="mx-auto h-5 w-5 text-gray-300" />
                <p className="mt-2 text-sm font-medium text-gray-700">No one has connected their Gmail yet</p>
                <p className="mt-0.5 text-xs text-gray-500">Start with yours, then ask whoever sends invoices to do the same.</p>
              </div>
            ) : (
              <ul className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200">
                {status.connections.map(c => (
                  <ConnectionRow
                    key={c.user_id}
                    connection={c}
                    canRemove={c.is_me || status.is_admin}
                    busy={busy}
                    onTest={() => run('test', async () => { const r = await sendGmailTest(); toast(`Test sent to ${c.email}, ${signatureNote(r.signature)}`); })}
                    onReconnect={() => run('connect', connectGmail)}
                    onRemove={() => {
                      const msg = c.is_me
                        ? 'Disconnect your Gmail? Invoices picked to come from you will go to you to forward instead.'
                        : `Disconnect ${c.name}'s Gmail? Invoices picked to come from them will go to them to forward instead.`;
                      if (window.confirm(msg)) void run(`remove-${c.user_id}`, () => disconnectGmail(c.is_me ? undefined : c.user_id), 'Gmail disconnected');
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* 2. Sending */}
        <div className="space-y-5 p-5">
          {/* Who it comes from, as agreed with Isa (2026-11-02). */}
          <div className="rounded-lg border border-gray-100 bg-gray-50/60 p-4">
            <p className="text-xs font-semibold text-gray-700">Who it comes from</p>
            <ol className="mt-2 space-y-1.5 text-xs text-gray-600">
              <li className="flex gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-[10px] font-semibold text-brand-primary">1</span>
                Whoever created the proposal, from their own Gmail (a proposal can pick someone else under &quot;Invoice sent by&quot;).
              </li>
              <li className="flex gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-[10px] font-semibold text-brand-primary">2</span>
                If they haven&apos;t connected their Gmail, the fallback sender below, with the intro email so the client knows who they are.
              </li>
              <li className="flex gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-[10px] font-semibold text-brand-primary">3</span>
                If neither is connected, nothing goes to the client: the payment link goes to the proposal&apos;s sender to forward.
              </li>
            </ol>
            <div className="mt-4">
              <label className="mb-1 block text-xs font-medium text-gray-500">Fallback sender</label>
              <Select value={value.fallback_sender_email} onValueChange={v => set({ fallback_sender_email: v })}>
                <SelectTrigger className="h-9 w-full max-w-sm bg-white text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fallbackOptions.map(o => (
                    <SelectItem key={o.email} value={o.email}>
                      <SelectItemText>{o.label}</SelectItemText>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {status && !fallbackConnected && (
                <p className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-700">
                  <AlertTriangle className="h-3 w-3" /> {value.fallback_sender_email} hasn&apos;t connected their Gmail yet, so step 2 can&apos;t happen until they do.
                </p>
              )}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Always copy</label>
            <input
              type="text"
              value={ccRaw}
              onChange={e => setCcRaw(e.target.value)}
              onBlur={() => {
                const list = parseEmails(ccRaw);
                setCcRaw(list.join(', '));
                set({ cc_emails: list });
              }}
              placeholder="maria@ecdigitalstrategy.com"
              className={wide}
            />
            <p className="mt-1 text-[11px] text-gray-400">On every invoice email and every client reminder. Separate with commas.</p>
          </div>

          <TemplateEditor
            tabs={[
              { key: 'usual', label: 'Usual email', hint: 'From the proposal’s creator.', subject: value.subject, body: value.body, onSubject: v => set({ subject: v }), onBody: v => set({ body: v }) },
              { key: 'intro', label: 'Intro email (fallback sender)', hint: 'When it comes from the fallback sender, who the client may not know.', subject: value.intro_subject, body: value.intro_body, onSubject: v => set({ intro_subject: v }), onBody: v => set({ intro_body: v }) },
            ]}
            inputClass={wide}
            canTest={Boolean(status?.mine)}
            testDisabledReason="Connect your Gmail above to send yourself a test"
          />
        </div>

        {/* 3. Reminders */}
        <div className="space-y-5 p-5">
          <ToggleRow
            title="Remind the team about unpaid invoices"
            description={
              <>
                Checks Xero every morning. If an invoice is still unpaid a set number of days after it was sent, the people below
                get an email, then weekly until it&apos;s paid.
                {value.nudges_since ? ` Covers invoices from ${shortDate(`${value.nudges_since}T12:00:00`)} on.` : ' Covers invoices from the day you switch it on.'}
              </>
            }
            checked={value.overdue_nudges}
            onChange={v => set({
              overdue_nudges: v,
              // Only invoices from now on: switching it on never sends a pile of reminders about old ones.
              nudges_since: v ? (value.nudges_since ?? new Date().toISOString().slice(0, 10)) : value.nudges_since,
            })}
          >
            <div className="mt-3 flex items-center gap-2 text-sm text-gray-600">
              <BellRing className="h-4 w-4 text-gray-400" />
              First reminder
              <input
                type="number"
                min={1}
                max={60}
                value={value.nudge_after_days}
                onChange={e => set({ nudge_after_days: Math.max(1, Math.min(60, Number(e.target.value) || 7)) })}
                className="w-16 rounded-lg border border-gray-200 px-2 py-1 text-center text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
              />
              days after the invoice is sent
            </div>
          </ToggleRow>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Who hears about it</label>
            <input
              type="text"
              value={remindRaw}
              onChange={e => setRemindRaw(e.target.value)}
              onBlur={() => {
                const list = parseEmails(remindRaw);
                setRemindRaw(list.join(', '));
                set({ reminder_emails: list });
              }}
              placeholder="xiomara@ecdigitalstrategy.com, maria@ecdigitalstrategy.com, isa@ecdigitalstrategy.com"
              className={wide}
            />
          </div>

          <div className="border-t border-gray-100 pt-5">
            <ToggleRow
              title="Also remind the client"
              description="On the same days, a short, polite reminder to the client from the Gmail the invoice came from, with the people in Always copy copied."
              checked={value.client_reminders}
              onChange={v => set({ client_reminders: v })}
              disabled={!value.overdue_nudges}
            />
            {!value.overdue_nudges && <p className="mt-1 text-[11px] text-gray-400">Turn on team reminders first.</p>}
            {value.client_reminders && (
              <div className="mt-4">
                <TemplateEditor
                  tabs={[{ key: 'reminder', label: 'Client reminder', hint: 'Sent to the client.', subject: value.reminder_subject, body: value.reminder_body, onSubject: v => set({ reminder_subject: v }), onBody: v => set({ reminder_body: v }) }]}
                  inputClass={wide}
                  canTest={Boolean(status?.mine)}
                  testDisabledReason="Connect your Gmail above to send yourself a test"
                />
              </div>
            )}
          </div>
        </div>

        {/* 4. Google app, admins only */}
      </div>
    </SettingsCard>
  );
}

type TemplateTab = {
  key: string;
  label: string;
  hint: string;
  subject: string;
  body: string;
  onSubject: (v: string) => void;
  onBody: (v: string) => void;
};

/** Subject and body of one or more emails, a tab each. */
function TemplateEditor({
  tabs,
  inputClass,
  canTest,
  testDisabledReason,
}: {
  tabs: TemplateTab[];
  inputClass: string;
  /** Whether your own Gmail is connected, so a test can go out. */
  canTest: boolean;
  testDisabledReason?: string;
}) {
  const toast = useToast();
  const [active, setActive] = useState(tabs[0].key);
  const [testing, setTesting] = useState(false);
  const tab = tabs.find(t => t.key === active) ?? tabs[0];
  return (
    <div>
      {tabs.length > 1 && (
        <div className="mb-3 inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
          {tabs.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActive(t.key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${t.key === tab.key ? 'bg-white text-brand-primary shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <p className="mb-2 text-[11px] text-gray-400">{tab.hint}</p>
      <label className="mb-1 block text-xs font-medium text-gray-500">Subject</label>
      <input type="text" value={tab.subject} onChange={e => tab.onSubject(e.target.value)} className={inputClass} />
      <label className="mb-1 mt-3 block text-xs font-medium text-gray-500">Email</label>
      <textarea value={tab.body} onChange={e => tab.onBody(e.target.value)} rows={11} className={`${inputClass} resize-y leading-relaxed`} />
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="mr-1 text-[11px] text-gray-400">Fills in:</span>
        {PLACEHOLDERS.map(p => (
          <code key={p} className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">{`{${p}}`}</code>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-gray-400">The sender&apos;s own Gmail signature is added underneath automatically.</p>
        <button
          type="button"
          disabled={!canTest || testing}
          title={canTest ? 'Sends this email, as it stands now, to your own inbox from your Gmail, with example values' : testDisabledReason}
          onClick={async () => {
            setTesting(true);
            try {
              const r = await sendGmailTest({ template: tab.key as 'usual' | 'intro' | 'reminder', subject: tab.subject, body: tab.body });
              toast(`Test of the ${tab.label.toLowerCase()} sent to ${r.to}, ${signatureNote(r.signature)}`);
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Could not send the test');
            } finally {
              setTesting(false);
            }
          }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send me a test
        </button>
      </div>
    </div>
  );
}

function ConnectionRow({
  connection: c,
  canRemove,
  busy,
  onTest,
  onReconnect,
  onRemove,
}: {
  connection: GmailConnection;
  canRemove: boolean;
  busy: string | null;
  onTest: () => void;
  onReconnect: () => void;
  onRemove: () => void;
}) {
  const needsReconnect = Boolean(c.last_error && /expired|reconnect|invalid_grant/i.test(c.last_error));
  const used = shortDate(c.last_used_at);
  return (
    <li className="flex flex-wrap items-center gap-3 bg-white px-4 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-primary/10 text-xs font-semibold text-brand-primary">
        {initials(c.name)}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-900">
          {c.name}
          {c.is_me && <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">You</span>}
          {needsReconnect ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
              <AlertTriangle className="h-3 w-3" /> Needs reconnecting
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
              <CheckCircle2 className="h-3 w-3" /> Connected
            </span>
          )}
        </p>
        <p className="truncate text-xs text-gray-500">
          {c.email} · connected {shortDate(c.connected_at)}{used ? ` · last sent ${used}` : ''}
        </p>
        {c.last_error && !needsReconnect && <p className="mt-0.5 text-[11px] text-amber-700">Last problem: {c.last_error}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {c.is_me && needsReconnect && (
          <button type="button" disabled={busy !== null} onClick={onReconnect} className="rounded-lg gradient-bg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
            Reconnect
          </button>
        )}
        {c.is_me && !needsReconnect && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={onTest}
            title="An example invoice email to yourself, from your Gmail"
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {busy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send me a test
          </button>
        )}
        {/* Connected before the signature permission existed? One reconnect adds it. */}
        {c.is_me && !needsReconnect && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={onReconnect}
            title="Sign in with Google again, e.g. so your Gmail signature can be added"
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-400 hover:bg-gray-50 hover:text-gray-700 disabled:opacity-50"
          >
            Reconnect
          </button>
        )}
        {canRemove && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={onRemove}
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-400 hover:bg-gray-50 hover:text-red-600 disabled:opacity-50"
          >
            {busy === `remove-${c.user_id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Disconnect'}
          </button>
        )}
      </div>
    </li>
  );
}
