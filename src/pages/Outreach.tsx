import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clock, Copy, ExternalLink, Loader2, Mail, Pause, Play, PlugZap, RefreshCw, Send, Sparkles, X } from 'lucide-react';
import TopBar from '../components/layout/TopBar';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/ui/Toast';
import {
  REPORT_BASE,
  deleteProspect,
  draftEmail,
  gmailComposeUrl,
  listProspects,
  parseDomains,
  screenDomains,
  startOutreachAudit,
  updateProspect,
  connectMailbox,
  disconnectMailbox,
  getSendStatus,
  queueProspect,
  saveSendSettings,
  sendNow,
  unqueueProspect,
  type OutreachProspect,
  type OutreachSendStatus,
  type ScreenResult,
} from '../lib/outreach';

// Outreach (Emil, 2026-11-01, sending added 2026-11-02): see src/lib/outreach.ts.
// Emil approves every email: Send now, or Queue it for the autopilot, which sends
// up to the daily limit on US weekdays and follows up twice unless they reply.

const GROUPS: Array<{ key: string; title: string; note: string; match: (p: OutreachProspect) => boolean }> = [
  { key: 'ready', title: 'Ready to send', note: 'Check the email and who it goes to, then send it now or queue it.', match: (p) => p.status === 'ready' },
  { key: 'approved', title: 'Queued', note: 'Goes out on its own, in this order, within the daily limit on US weekdays.', match: (p) => p.status === 'approved' },
  { key: 'auditing', title: 'Auditing', note: 'The audit runs on the server and takes a few minutes. Draft the email once it is done.', match: (p) => p.status === 'auditing' || p.status === 'failed' },
  { key: 'new', title: 'To audit', note: 'Passed the checks: not a client, not in HubSpot, on Shopify.', match: (p) => p.status === 'new' },
  { key: 'replied', title: 'Replied', note: 'They answered, so follow-ups stopped. Pick it up in your inbox.', match: (p) => p.status === 'replied' },
  { key: 'sent', title: 'Sent', note: 'Up to two short follow-ups go out, 3 and 7 days later, unless they reply.', match: (p) => ['sent', 'bounced', 'unsubscribed'].includes(p.status) },
  { key: 'skipped', title: 'Skipped', note: 'Never audited or emailed.', match: (p) => p.status === 'skipped' },
];

export default function Outreach() {
  const { user } = useAuth();
  const showToast = useToast();
  const [prospects, setProspects] = useState<OutreachProspect[] | null>(null);
  const [paste, setPaste] = useState('');
  const [screening, setScreening] = useState(false);
  const [lastScreen, setLastScreen] = useState<ScreenResult[] | null>(null);
  const [sending, setSending] = useState<OutreachSendStatus | null>(null);
  const loadSending = useCallback(async () => {
    try {
      setSending(await getSendStatus());
    } catch {
      // The panel shows as not connected.
    }
  }, []);
  useEffect(() => { void loadSending(); }, [loadSending]);

  const load = useCallback(async () => {
    try {
      setProspects(await listProspects());
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not load prospects');
    }
  }, [showToast]);

  useEffect(() => { void load(); }, [load]);

  // While anything is auditing, look again every 20 seconds.
  const anyAuditing = (prospects ?? []).some((p) => p.status === 'auditing' && p.audit?.status !== 'published');
  useEffect(() => {
    if (!anyAuditing) return;
    const id = window.setInterval(() => { void load(); }, 20_000);
    return () => window.clearInterval(id);
  }, [anyAuditing, load]);

  const screen = async () => {
    const domains = parseDomains(paste);
    if (domains.length === 0) return;
    setScreening(true);
    try {
      const results = await screenDomains(domains);
      setLastScreen(results);
      setPaste('');
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Screening failed');
    } finally {
      setScreening(false);
    }
  };

  const grouped = useMemo(
    () => GROUPS.map((g) => ({ ...g, items: (prospects ?? []).filter(g.match) })),
    [prospects],
  );

  return (
    <div className="flex flex-1 flex-col">
      <TopBar title="Outreach" subtitle="Free website audits for cold outreach. You approve and send every email." />
      <div className="space-y-8 p-4 md:p-8">
        <SendingPanel status={sending} onChanged={loadSending} />

        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-gray-900">Add stores</h2>
          <p className="mt-1 text-xs text-gray-500">
            Paste store websites, one per line (up to 50). Anyone already a client or in HubSpot is skipped, and so is
            anything not on Shopify.
          </p>
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={4}
            placeholder={'brand.com\nanotherbrand.com'}
            className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-900 focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={screen}
              disabled={screening || parseDomains(paste).length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:bg-brand-primary-dark disabled:opacity-50"
            >
              {screening ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {screening ? 'Checking…' : 'Check and add'}
            </button>
            {screening && <span className="text-xs text-gray-500">Checking HubSpot and each website, a few seconds per store.</span>}
          </div>
          {lastScreen && (
            <ul className="mt-4 space-y-1 border-t border-gray-100 pt-3 text-xs">
              {lastScreen.map((r) => (
                <li key={r.domain} className="flex gap-2">
                  <span className={r.status === 'new' ? 'font-medium text-emerald-700' : 'text-gray-500'}>
                    {r.status === 'new' ? 'Added' : r.status === 'exists' ? 'Already listed' : r.status === 'invalid' ? 'Not added' : 'Skipped'}
                  </span>
                  <span className="text-gray-900">{r.store_name ? `${r.store_name} (${r.domain})` : r.domain}</span>
                  {r.reason && <span className="text-gray-400">{r.reason}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>

        {prospects === null ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : prospects.length === 0 ? (
          <p className="text-sm text-gray-500">No stores yet. Paste a few above to start a test batch.</p>
        ) : (
          grouped.filter((g) => g.items.length > 0).map((g) => (
            <section key={g.key}>
              <div className="mb-3 flex items-baseline gap-2">
                <h2 className="text-sm font-semibold text-gray-900">{g.title}</h2>
                <span className="text-xs tabular-nums text-gray-400">{g.items.length}</span>
                {g.note && <span className="text-xs text-gray-400">{g.note}</span>}
              </div>
              <div className="space-y-3">
                {g.items.map((p) => (
                  <ProspectCard
                    key={p.id}
                    prospect={p}
                    userId={user?.id ?? ''}
                    canSend={Boolean(sending?.mailbox) && !sending?.settings.paused}
                    onChanged={async () => { await Promise.all([load(), loadSending()]); }}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function ProspectCard({
  prospect: p,
  userId,
  canSend,
  onChanged,
}: {
  prospect: OutreachProspect;
  userId: string;
  canSend: boolean;
  onChanged: () => Promise<void>;
}) {
  const showToast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [subject, setSubject] = useState(p.email_subject ?? '');
  const [body, setBody] = useState(p.email_body ?? '');
  const [toEmail, setToEmail] = useState(p.contact_email ?? '');
  const [toName, setToName] = useState(p.contact_name ?? '');

  useEffect(() => {
    setSubject(p.email_subject ?? '');
    setBody(p.email_body ?? '');
  }, [p.email_subject, p.email_body]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const saveEdits = () =>
    updateProspect(p.id, { email_subject: subject, email_body: body, contact_email: toEmail.trim() || null, contact_name: toName.trim() || null });

  const reportUrl = p.audit?.public_share_token ? `${REPORT_BASE}${p.audit.public_share_token}` : null;
  const auditDone = p.audit?.status === 'published';
  const name = p.store_name || p.domain;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-gray-900">{name}</p>
          <a href={`https://${p.domain}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-brand-primary">
            {p.domain} <ExternalLink className="h-3 w-3" />
          </a>
          {(p.skip_reason || p.notes) && (
            <p className="mt-1 whitespace-pre-line text-xs text-gray-400">{p.skip_reason ?? p.notes}</p>
          )}
          {p.sent_at && (
            <p className="mt-1 text-xs text-gray-500">
              Sent {new Date(p.sent_at).toLocaleDateString()}
              {p.contact_email ? ` to ${p.contact_email}` : ''}
              {p.followups_sent ? `, ${p.followups_sent} follow-up${p.followups_sent === 1 ? '' : 's'}` : ''}
              {p.status === 'replied' ? ', replied' : p.status === 'bounced' ? ', bounced' : ''}
            </p>
          )}
          {p.status === 'approved' && <p className="mt-1 text-xs text-gray-500">Queued{p.contact_email ? ` for ${p.contact_email}` : ''}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {reportUrl && (
            <a href={reportUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              <ExternalLink className="h-3.5 w-3.5" /> Their report
            </a>
          )}
          {p.audit_id && (
            <Link to={`/audits/${p.audit_id}`} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              Full audit
            </Link>
          )}
          {p.status === 'new' && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run('audit', () => startOutreachAudit(p, userId))}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-primary-dark disabled:opacity-50"
            >
              {busy === 'audit' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Run audit
            </button>
          )}
          {p.status === 'auditing' && !auditDone && (
            <span className="inline-flex items-center gap-1.5 text-xs text-gray-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Auditing</span>
          )}
          {(p.status === 'auditing' && auditDone) && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run('draft', () => draftEmail(p.id))}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-primary-dark disabled:opacity-50"
            >
              {busy === 'draft' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />} Draft email
            </button>
          )}
          {p.status === 'sent' && (
            <button type="button" disabled={busy !== null} onClick={() => run('replied', () => updateProspect(p.id, { status: 'replied' }))} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              They replied
            </button>
          )}
          {p.status === 'approved' && (
            <button type="button" disabled={busy !== null} onClick={() => run('unqueue', () => unqueueProspect(p.id))} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              Back to editing
            </button>
          )}
          {['new', 'auditing', 'ready', 'approved', 'failed'].includes(p.status) && (
            <button
              type="button"
              title="Skip this store"
              disabled={busy !== null}
              onClick={() => run('skip', () => updateProspect(p.id, { status: 'skipped', skip_reason: 'Skipped by hand' }))}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {p.status === 'skipped' && (
            <button type="button" title="Remove from the list (it can then be added again)" onClick={() => run('delete', () => deleteProspect(p.id))} className="text-xs text-gray-400 hover:text-gray-700">
              Remove
            </button>
          )}
        </div>
      </div>

      {p.status === 'ready' && (
        <div className="mt-4 space-y-2 border-t border-gray-100 pt-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <input value={toName} onChange={(e) => setToName(e.target.value)} onBlur={() => void saveEdits()} placeholder="Their name (optional)" className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm" />
            <input value={toEmail} onChange={(e) => setToEmail(e.target.value)} onBlur={() => void saveEdits()} placeholder="Their email" type="email" className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm" />
          </div>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={() => void saveEdits()} placeholder="Subject" className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium" />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} onBlur={() => void saveEdits()} rows={10} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm leading-relaxed text-gray-800" />
          <div className="flex flex-wrap items-center gap-2">
            {canSend && (
              <>
                <button
                  type="button"
                  disabled={busy !== null || !toEmail.trim()}
                  title={toEmail.trim() ? 'Send it now from your mailbox' : 'Add their email first'}
                  onClick={() => run('send', async () => { await saveEdits(); await sendNow(p.id); })}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-primary-dark disabled:opacity-50"
                >
                  {busy === 'send' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send now
                </button>
                <button
                  type="button"
                  disabled={busy !== null || !toEmail.trim()}
                  title="Send it automatically, within the daily limit, in US working hours"
                  onClick={() => run('queue', async () => { await saveEdits(); await queueProspect(p.id); })}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-brand-primary/30 px-3 py-1.5 text-xs font-medium text-brand-primary hover:bg-brand-primary/5 disabled:opacity-50"
                >
                  <Clock className="h-3.5 w-3.5" /> Queue
                </button>
              </>
            )}
            <a
              href={toEmail.trim() ? gmailComposeUrl(toEmail.trim(), subject, body) : undefined}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => { if (!toEmail.trim()) { e.preventDefault(); showToast('Add their email first'); } else void saveEdits(); }}
              className={canSend
                ? 'inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50'
                : `inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white ${toEmail.trim() ? 'bg-brand-primary hover:bg-brand-primary-dark' : 'bg-brand-primary/40'}`}
            >
              <Mail className="h-3.5 w-3.5" /> Open in Gmail
            </a>
            <button
              type="button"
              onClick={() => { void navigator.clipboard.writeText(`${subject}\n\n${body}`); showToast('Copied'); }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run('redraft', () => draftEmail(p.id))}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {busy === 'redraft' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Redraft
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run('sent', async () => { await saveEdits(); await updateProspect(p.id, { status: 'sent', sent_at: new Date().toISOString() }); })}
              className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" /> Mark as sent
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SendingPanel({ status, onChanged }: { status: OutreachSendStatus | null; onChanged: () => Promise<void> }) {
  const showToast = useToast();
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [booking, setBooking] = useState('');
  const [address, setAddress] = useState('');

  useEffect(() => {
    setBooking(status?.settings.booking_url ?? '');
    setAddress(status?.settings.postal_address ?? '');
  }, [status?.settings.booking_url, status?.settings.postal_address]);

  const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    try {
      await fn();
      await onChanged();
      if (done) showToast(done);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const settings = status?.settings;
  const paused = Boolean(settings?.paused);

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Sending</h2>
          {status?.mailbox ? (
            <p className="mt-1 text-xs text-gray-500">
              From <span className="font-medium text-gray-800">{status.mailbox}</span>. {status.sent_today} of {settings?.daily_new_cap ?? 3} sent
              today. Queued emails go out on US weekdays, 9am to 4pm New York time.
            </p>
          ) : (
            <p className="mt-1 text-xs text-gray-500">Connect the mailbox the emails come from. Until then, use Open in Gmail on each email.</p>
          )}
          {paused && (
            <p className="mt-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
              <span className="font-semibold">Paused.</span> {settings?.pause_reason ?? ''}
            </p>
          )}
        </div>
        {status?.mailbox && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run('pause', () => saveSendSettings({ paused: !paused }), paused ? 'Sending resumed' : 'Sending paused')}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ${paused ? 'bg-brand-primary text-white hover:bg-brand-primary-dark' : 'border border-gray-200 text-gray-700 hover:bg-gray-50'}`}
            >
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />} {paused ? 'Resume sending' : 'Pause sending'}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                if (window.confirm('Disconnect the mailbox? Queued emails wait until you connect it again.')) {
                  void run('disconnect', disconnectMailbox, 'Mailbox disconnected');
                }
              }}
              className="text-xs text-gray-400 hover:text-gray-700"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

      {!status?.mailbox && (
        <form
          className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void run('connect', async () => { await connectMailbox(user, pass); setPass(''); }, 'Mailbox connected');
          }}
        >
          <input value={user} onChange={(e) => setUser(e.target.value)} type="email" placeholder="emil@ecdigitalstrategy.com" className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm" />
          <input value={pass} onChange={(e) => setPass(e.target.value)} type="password" autoComplete="new-password" placeholder="Google app password" className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm" />
          <button type="submit" disabled={busy !== null || !user.trim() || !pass.trim()} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-primary px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-primary-dark disabled:opacity-50">
            {busy === 'connect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} Connect
          </button>
          <p className="text-[11px] text-gray-400 sm:col-span-3">
            Make the app password at myaccount.google.com/apppasswords. We check it by signing in, store it encrypted, and it is never shown again.
          </p>
        </form>
      )}

      <div className="mt-4 grid gap-2 border-t border-gray-100 pt-4 sm:grid-cols-2">
        <label className="text-xs text-gray-500">
          Booking link (used in follow-ups and on their report)
          <input
            value={booking}
            onChange={(e) => setBooking(e.target.value)}
            onBlur={() => { if (booking !== (settings?.booking_url ?? '')) void run('booking', () => saveSendSettings({ booking_url: booking }), 'Saved'); }}
            placeholder="https://calendly.com/..."
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-900"
          />
        </label>
        <label className="text-xs text-gray-500">
          Postal address (added under every first email)
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onBlur={() => { if (address !== (settings?.postal_address ?? '')) void run('address', () => saveSendSettings({ postal_address: address }), 'Saved'); }}
            placeholder="Street, city, state, ZIP"
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-900"
          />
        </label>
      </div>
    </section>
  );
}
