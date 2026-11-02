import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
  listSends,
  testSend,
  type OutreachProspect,
  type OutreachSend,
  type OutreachSendStatus,
  type ScreenResult,
} from '../lib/outreach';

// Outreach (Emil, 2026-11-01, sending added 2026-11-02): see src/lib/outreach.ts.
// Three tabs (2026-11-02): Overview (where things stand, and every email sent),
// Prospects (add stores, audit, draft, send or queue) and Settings (mailbox,
// how many and when, booking link, his signature). Emil approves every email.

const GROUPS: Array<{ key: string; title: string; note: string; match: (p: OutreachProspect) => boolean }> = [
  { key: 'ready', title: 'Ready to send', note: 'Check the email and who it goes to, then send it now or queue it.', match: (p) => p.status === 'ready' },
  { key: 'approved', title: 'Queued', note: 'Goes out on its own, in this order, within the daily limit on US weekdays.', match: (p) => p.status === 'approved' },
  { key: 'auditing', title: 'Auditing', note: 'The audit runs on the server and takes a few minutes. Draft the email once it is done.', match: (p) => p.status === 'auditing' || p.status === 'failed' },
  { key: 'new', title: 'To audit', note: 'Passed the checks: not a client, not in HubSpot, on Shopify.', match: (p) => p.status === 'new' },
  { key: 'replied', title: 'Replied', note: 'They answered, so follow-ups stopped. Pick it up in your inbox.', match: (p) => p.status === 'replied' },
  { key: 'sent', title: 'Sent', note: 'One short follow-up goes out 3 days later, unless they reply.', match: (p) => ['sent', 'bounced', 'unsubscribed'].includes(p.status) },
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
  const [params, setParams] = useSearchParams();
  const tab: TabKey = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'overview');
  const setTab = (key: TabKey) => setParams(key === 'overview' ? {} : { tab: key }, { replace: true });
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
      <TopBar title="Outreach" subtitle="Free website audits for cold outreach. You approve every email." />
      <div className="border-b border-gray-200 bg-white px-4 md:px-8">
        <nav className="flex gap-1" aria-label="Outreach sections">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-current={tab === t.key ? 'page' : undefined}
              className={`border-b-2 px-3 py-3 text-sm font-medium transition-colors ${tab === t.key ? 'border-brand-primary text-brand-primary' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="space-y-8 p-4 md:p-8">
        {tab === 'overview' && (
          <OverviewTab prospects={prospects ?? []} sending={sending} onOpenProspects={() => setTab('prospects')} />
        )}
        {tab === 'settings' && <SettingsTab status={sending} onChanged={loadSending} />}
        {tab === 'prospects' && (<>
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
        </>)}
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
              {(p.report_views ?? 0) > 0 ? `, opened their report ${p.report_views}x` : ''}
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
            {canSend && (
              <button
                type="button"
                disabled={busy !== null}
                title="Send this email to your own mailbox, exactly as they would get it"
                onClick={() => run('test', async () => { await saveEdits(); await testSend(p.id); showToast('Test sent to your mailbox'); })}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {busy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />} Test to me
              </button>
            )}
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

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'prospects', label: 'Prospects' },
  { key: 'settings', label: 'Settings' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function OverviewTab({
  prospects,
  sending,
  onOpenProspects,
}: {
  prospects: OutreachProspect[];
  sending: OutreachSendStatus | null;
  onOpenProspects: () => void;
}) {
  const [sends, setSends] = useState<OutreachSend[] | null>(null);
  useEffect(() => {
    listSends().then(setSends, () => setSends([]));
  }, [prospects]);

  const byId = useMemo(() => new Map(prospects.map((p) => [p.id, p])), [prospects]);
  const count = (fn: (p: OutreachProspect) => boolean) => prospects.filter(fn).length;
  const contacted = count((p) => Boolean(p.sent_at));
  const replied = count((p) => p.status === 'replied');
  const opened = count((p) => (p.report_views ?? 0) > 0);
  const pct = (n: number) => (contacted > 0 ? `${Math.round((n / contacted) * 100)}%` : 'n/a');

  const tiles: Array<{ label: string; value: string | number; note?: string }> = [
    { label: 'Stores checked', value: prospects.length, note: `${count((p) => p.status === 'skipped')} skipped` },
    { label: 'Audited', value: count((p) => Boolean(p.audit_id)), note: `${count((p) => p.status === 'auditing')} running now` },
    { label: 'Ready or queued', value: count((p) => p.status === 'ready' || p.status === 'approved'), note: `${count((p) => p.status === 'approved')} queued` },
    { label: 'Emailed', value: contacted, note: `${sending?.sent_today ?? 0} of ${sending?.settings.daily_new_cap ?? 3} today` },
    { label: 'Opened their report', value: opened, note: pct(opened) },
    { label: 'Replied', value: replied, note: pct(replied) },
  ];

  const kindLabel: Record<OutreachSend['kind'], string> = { initial: 'First email', followup_1: 'Follow-up', followup_2: 'Second follow-up' };

  return (
    <div className="space-y-8">
      <section className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-gray-200 bg-white px-5 py-3 text-sm">
        {sending?.mailbox ? (
          sending.settings.paused ? (
            <span className="font-medium text-amber-700">Sending is paused. {sending.settings.pause_reason ?? ''}</span>
          ) : (
            <span className="text-gray-700">
              <span className="font-medium text-emerald-700">Sending is on</span> from {sending.mailbox}.{' '}
              {sending.in_window ? 'Inside sending hours now.' : 'Outside sending hours now; queued emails wait.'}
            </span>
          )
        ) : (
          <span className="text-gray-700">No mailbox connected yet. Connect it under Settings.</span>
        )}
        {count((p) => p.status === 'auditing' && p.audit?.status === 'published') > 0 && (
          <button type="button" onClick={onOpenProspects} className="text-xs font-medium text-brand-primary hover:underline">
            {count((p) => p.status === 'auditing' && p.audit?.status === 'published')} audit(s) ready for an email draft
          </button>
        )}
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-xs text-gray-500">{t.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{t.value}</p>
            {t.note && <p className="mt-0.5 text-xs text-gray-400">{t.note}</p>}
          </div>
        ))}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-gray-900">History</h2>
        {sends === null ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : sends.length === 0 ? (
          <p className="text-sm text-gray-500">Nothing sent yet. Emails you send or queue show up here.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-100 text-xs text-gray-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-4 py-2.5 font-medium">Store</th>
                  <th className="px-4 py-2.5 font-medium">To</th>
                  <th className="px-4 py-2.5 font-medium">Email</th>
                  <th className="px-4 py-2.5 font-medium">Where they are now</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sends.map((s) => {
                  const p = byId.get(s.prospect_id);
                  const now = s.status === 'failed'
                    ? `Not sent: ${s.error ?? 'unknown error'}`
                    : p?.status === 'replied'
                      ? 'Replied'
                      : p?.status === 'bounced'
                        ? 'Bounced'
                        : (p?.report_views ?? 0) > 0
                          ? `Opened their report${(p?.report_views ?? 0) > 1 ? ` ${p?.report_views} times` : ''}`
                          : 'No reply yet';
                  return (
                    <tr key={s.id} className="align-top">
                      <td className="whitespace-nowrap px-4 py-2.5 text-gray-500">
                        {new Date(s.sent_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </td>
                      <td className="px-4 py-2.5 font-medium text-gray-900">{p?.store_name || p?.domain || 'Removed'}</td>
                      <td className="px-4 py-2.5 text-gray-600">{s.to_email}</td>
                      <td className="px-4 py-2.5 text-gray-600">
                        <span className="text-gray-900">{kindLabel[s.kind]}</span>
                        <span className="block max-w-xs truncate text-xs text-gray-400">{s.subject}</span>
                      </td>
                      <td className={`px-4 py-2.5 text-xs ${s.status === 'failed' || p?.status === 'bounced' ? 'text-red-600' : p?.status === 'replied' ? 'font-medium text-emerald-700' : 'text-gray-500'}`}>
                        {now}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function SettingsTab({ status, onChanged }: { status: OutreachSendStatus | null; onChanged: () => Promise<void> }) {
  const showToast = useToast();
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const settings = status?.settings;
  const [form, setForm] = useState({
    daily_new_cap: 3,
    max_followups: 1,
    followup_gap_days: 3,
    send_start_hour: 9,
    send_end_hour: 16,
    min_gap_minutes: 45,
    booking_url: '',
    signature_html: '',
  });

  useEffect(() => {
    if (!settings) return;
    setForm({
      daily_new_cap: settings.daily_new_cap,
      max_followups: settings.max_followups,
      followup_gap_days: settings.followup_gap_days,
      send_start_hour: settings.send_start_hour,
      send_end_hour: settings.send_end_hour,
      min_gap_minutes: settings.min_gap_minutes,
      booking_url: settings.booking_url ?? '',
      signature_html: settings.signature_html ?? '',
    });
  }, [settings]);

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

  const paused = Boolean(settings?.paused);
  const dirty =
    settings !== undefined &&
    (form.daily_new_cap !== settings.daily_new_cap ||
      form.max_followups !== settings.max_followups ||
      form.followup_gap_days !== settings.followup_gap_days ||
      form.send_start_hour !== settings.send_start_hour ||
      form.send_end_hour !== settings.send_end_hour ||
      form.min_gap_minutes !== settings.min_gap_minutes ||
      form.booking_url !== (settings.booking_url ?? '') ||
      form.signature_html !== (settings.signature_html ?? ''));

  const num = (key: keyof typeof form, label: string, min: number, max: number, note?: string) => (
    <label className="text-xs text-gray-500">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        value={form[key] as number}
        onChange={(e) => setForm((f) => ({ ...f, [key]: Number(e.target.value) }))}
        className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-900"
      />
      {note && <span className="mt-0.5 block text-[11px] text-gray-400">{note}</span>}
    </label>
  );

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Mailbox</h2>
            {status?.mailbox ? (
              <p className="mt-1 text-xs text-gray-500">
                Emails go out from <span className="font-medium text-gray-800">{status.mailbox}</span>, and replies land in its inbox.
              </p>
            ) : (
              <p className="mt-1 text-xs text-gray-500">Connect the mailbox the emails come from.</p>
            )}
            {paused && (
              <p className="mt-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                <span className="font-semibold">Paused.</span> {settings?.pause_reason ?? ''}
              </p>
            )}
          </div>
          {status?.mailbox && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run('test', () => testSend(), `Test sent to ${status.mailbox}`)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                {busy === 'test' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />} Send me a test
              </button>
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
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-900">How much and when</h2>
        <p className="mt-1 text-xs text-gray-500">Queued emails go out on US weekdays, New York time. Anyone who replies is never followed up.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {num('daily_new_cap', 'New emails per day', 0, 10, 'First emails only. 0 stops new sends.')}
          {num('max_followups', 'Follow-ups per person', 0, 2)}
          {num('followup_gap_days', 'Days before a follow-up', 1, 14)}
          {num('send_start_hour', 'Send from (hour, 0-23)', 0, 23)}
          {num('send_end_hour', 'Send until (hour, 1-24)', 1, 24)}
          {num('min_gap_minutes', 'Minutes between first emails', 5, 240)}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-900">Booking link and signature</h2>
        <label className="mt-3 block text-xs text-gray-500">
          Booking link (used in follow-ups and on their report)
          <input
            value={form.booking_url}
            onChange={(e) => setForm((f) => ({ ...f, booking_url: e.target.value }))}
            placeholder="https://calendly.com/..."
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-900"
          />
        </label>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <label className="text-xs text-gray-500">
            Signature (HTML, added under every email)
            <textarea
              value={form.signature_html}
              onChange={(e) => setForm((f) => ({ ...f, signature_html: e.target.value }))}
              rows={10}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-[11px] text-gray-800"
            />
          </label>
          <div className="text-xs text-gray-500">
            Preview
            {/* Sandboxed: the signature's HTML is shown, never run. */}
            <iframe
              title="Signature preview"
              sandbox=""
              srcDoc={`<body style="margin:12px;font-family:Arial,sans-serif">${form.signature_html || '<p style="color:#999;font-size:12px">No signature</p>'}</body>`}
              className="mt-1 h-[214px] w-full rounded-lg border border-gray-200 bg-white"
            />
          </div>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy !== null || !dirty}
          onClick={() => run('save', () => saveSendSettings(form), 'Settings saved')}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2 text-sm font-medium text-white hover:bg-brand-primary-dark disabled:opacity-50"
        >
          {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save settings
        </button>
        {dirty && <span className="text-xs text-gray-500">Unsaved changes</span>}
      </div>
    </div>
  );
}
