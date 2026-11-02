import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, BadgeCheck, CheckCircle2, ChevronDown, Clock, Copy, ExternalLink, Loader2, Mail, Pause, Play, PlugZap, RefreshCw, Send, Sparkles, UserSearch, X } from 'lucide-react';
import TopBar from '../components/layout/TopBar';
import { ToggleRow } from '../components/ui/ToggleSwitch';
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
  SCREEN_MAX,
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
  syncSignature,
  connectHunter,
  disconnectHunter,
  findDecisionMaker,
  getHunterStatus,
  isRoleAddress,
  doNotContact,
  REPLY_LABELS,
  type HunterStatus,
  type OutreachProspect,
  type OutreachSend,
  type OutreachSendStatus,
  type ScreenResult,
} from '../lib/outreach';
import { connectGmail } from '../lib/invoice-sending';

// Outreach (Emil, 2026-11-01, sending added 2026-11-02): see src/lib/outreach.ts.
// Three tabs (2026-11-02): Overview (where things stand, and every email sent),
// Prospects (add stores, audit, draft, send or queue) and Settings (mailbox,
// how many and when, booking link, his signature). Emil approves every email.

const GROUPS: Array<{ key: string; title: string; note: string; match: (p: OutreachProspect) => boolean }> = [
  { key: 'ready', title: 'Ready to send', note: 'Check the email and who it goes to, then send it now or queue it.', match: (p) => p.status === 'ready' },
  { key: 'approved', title: 'Queued', note: 'Goes out on its own, in this order, within the daily limit on US weekdays.', match: (p) => p.status === 'approved' },
  { key: 'auditing', title: 'Auditing', note: 'The audit runs on the server and takes a few minutes. Draft the email once it is done.', match: (p) => p.status === 'auditing' || p.status === 'failed' },
  { key: 'new', title: 'To audit', note: 'Passed the checks: not a client, not in HubSpot, on Shopify. Best lead score first.', match: (p) => p.status === 'new' },
  { key: 'replied', title: 'Replied', note: 'They answered, so follow-ups stopped. You get an email for each one worth answering.', match: (p) => p.status === 'replied' },
  { key: 'sent', title: 'Sent', note: 'One short follow-up goes out 3 days later, unless they reply.', match: (p) => ['sent', 'bounced'].includes(p.status) },
  { key: 'unsubscribed', title: 'Said no', note: 'On the do-not-contact list for good: never screened, audited or emailed again.', match: (p) => p.status === 'unsubscribed' },
  { key: 'skipped', title: 'Skipped', note: 'Never audited or emailed.', match: (p) => p.status === 'skipped' },
];

export default function Outreach() {
  const { user } = useAuth();
  const showToast = useToast();
  const [prospects, setProspects] = useState<OutreachProspect[] | null>(null);
  const [paste, setPaste] = useState('');
  const [screening, setScreening] = useState(false);
  const [lastScreen, setLastScreen] = useState<ScreenResult[] | null>(null);
  const [screenProgress, setScreenProgress] = useState<{ done: number; total: number } | null>(null);
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
    setScreenProgress({ done: 0, total: Math.min(domains.length, SCREEN_MAX) });
    try {
      const results = await screenDomains(domains, (done, partial) => {
        setScreenProgress({ done, total: Math.min(domains.length, SCREEN_MAX) });
        setLastScreen(partial);
      });
      setLastScreen(results);
      setPaste('');
      await load();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Screening failed');
    } finally {
      setScreening(false);
      setScreenProgress(null);
    }
  };

  const grouped = useMemo(
    () => GROUPS.map((g) => {
      const items = (prospects ?? []).filter(g.match);
      if (g.key === 'new') items.sort((a, b) => (b.lead_score ?? -1) - (a.lead_score ?? -1));
      return { ...g, items };
    }),
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
            Paste store websites, one per line (up to {SCREEN_MAX}). Anyone already a client or in HubSpot is skipped, and so is
            anything not on Shopify or scoring under the lead score set in Settings.
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
            {screening && (
              <span className="text-xs text-gray-500">
                Checking HubSpot, each website and its traffic, a few seconds per store
                {screenProgress && screenProgress.total > 15 ? ` (${screenProgress.done} of ${screenProgress.total})` : ''}.
              </span>
            )}
          </div>
          {lastScreen && (
            <ul className="mt-4 space-y-1 border-t border-gray-100 pt-3 text-xs">
              {lastScreen.map((r) => (
                <li key={r.domain} className="flex gap-2">
                  <span className={r.status === 'new' ? 'font-medium text-emerald-700' : 'text-gray-500'}>
                    {r.status === 'new' ? 'Added' : r.status === 'exists' ? 'Already listed' : r.status === 'invalid' ? 'Not added' : 'Skipped'}
                  </span>
                  <span className="text-gray-900">{r.store_name ? `${r.store_name} (${r.domain})` : r.domain}</span>
                  {r.lead_score !== undefined && r.status === 'new' && <span className="tabular-nums text-gray-500">score {r.lead_score}</span>}
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

  // A lookup fills these on the server.
  useEffect(() => {
    setToEmail(p.contact_email ?? '');
    setToName(p.contact_name ?? '');
  }, [p.contact_email, p.contact_name]);

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

  // Typing a different address makes it Emil's own pick, no longer Hunter's checked one.
  const saveEdits = () => {
    const email = toEmail.trim() || null;
    const changed = email !== (p.contact_email ?? null);
    return updateProspect(p.id, {
      email_subject: subject,
      email_body: body,
      contact_email: email,
      contact_name: toName.trim() || null,
      ...(changed ? { contact_source: email ? 'manual' : null, contact_verified: null, contact_title: null } : {}),
    });
  };

  const lookup = () =>
    run('lookup', async () => {
      const r = await findDecisionMaker(p.id);
      if (r.found) showToast(`Found ${r.found.name ?? r.found.email}${r.found.title ? `, ${r.found.title}` : ''}`);
      else showToast(r.message ?? 'No one found');
    });
  const roleAddress = Boolean(toEmail.trim()) && isRoleAddress(toEmail);
  const canLookup = ['new', 'auditing', 'ready', 'failed'].includes(p.status);

  const reportUrl = p.audit?.public_share_token ? `${REPORT_BASE}${p.audit.public_share_token}` : null;
  const auditDone = p.audit?.status === 'published';
  const name = p.store_name || p.domain;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate text-sm font-semibold text-gray-900">
            {name}
            <LeadScoreBadge prospect={p} />
            {p.auto_started_at && <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">Auto</span>}
          </p>
          <a href={`https://${p.domain}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-brand-primary">
            {p.domain} <ExternalLink className="h-3 w-3" />
          </a>
          {p.contact_email && p.status !== 'skipped' && (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
              <span className="font-medium text-gray-800">{p.contact_name || p.contact_email}</span>
              {p.contact_title && <span className="text-gray-500">{p.contact_title}</span>}
              {p.contact_name && <span className="text-gray-400">{p.contact_email}</span>}
              <ContactBadge prospect={p} />
            </p>
          )}
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
          {p.reply_kind && (
            <div className="mt-2 max-w-xl rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-xs">
              <p>
                <span className={`font-semibold ${['interested', 'question', 'referral'].includes(p.reply_kind) ? 'text-emerald-700' : 'text-gray-700'}`}>{REPLY_LABELS[p.reply_kind]}</span>
                {p.reply_summary && <span className="text-gray-600">. {p.reply_summary}</span>}
              </p>
              {p.reply_text && <p className="mt-1 line-clamp-3 whitespace-pre-line text-gray-500">{p.reply_text}</p>}
            </div>
          )}
          {p.hubspot_error && <p className="mt-1 text-[11px] text-amber-700">Not in HubSpot: {p.hubspot_error}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {reportUrl && (
            <a href={`${reportUrl}?preview=1`} title="Your own look is not counted as an open" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              <ExternalLink className="h-3.5 w-3.5" /> Their report
            </a>
          )}
          {p.audit_id && (
            <Link to={`/audits/${p.audit_id}`} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              Full audit
            </Link>
          )}
          {canLookup && (
            <button
              type="button"
              disabled={busy !== null}
              title="Find the founder or marketing lead with Hunter, and check their address"
              onClick={lookup}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {busy === 'lookup' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserSearch className="h-3.5 w-3.5" />}
              {p.contact_email ? 'Look up again' : 'Find decision-maker'}
            </button>
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
          {['sent', 'replied', 'bounced'].includes(p.status) && (
            <button
              type="button"
              disabled={busy !== null}
              title="Stop all emails and never contact this company again"
              onClick={() => { if (window.confirm(`Never contact ${name} again?`)) void run('dnc', () => doNotContact(p.id)); }}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-800"
            >
              Do not contact
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
          {p.status === 'skipped' && /^(Low lead score|No decision-maker)/.test(p.skip_reason ?? '') && (
            <button type="button" disabled={busy !== null} onClick={() => run('keep', () => updateProspect(p.id, { status: 'new', skip_reason: null }))} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
              Keep anyway
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
          {roleAddress && (
            <p className="flex items-center gap-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              That is a shared inbox, not a person, so it cannot be sent from here. Find the decision-maker instead.
            </p>
          )}
          <input value={subject} onChange={(e) => setSubject(e.target.value)} onBlur={() => void saveEdits()} placeholder="Subject" className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium" />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} onBlur={() => void saveEdits()} rows={10} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm leading-relaxed text-gray-800" />
          <div className="flex flex-wrap items-center gap-2">
            {canSend && (
              <>
                <button
                  type="button"
                  disabled={busy !== null || !toEmail.trim() || roleAddress}
                  title={toEmail.trim() ? 'Send it now from your mailbox' : 'Add their email first'}
                  onClick={() => run('send', async () => { await saveEdits(); await sendNow(p.id); })}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-primary-dark disabled:opacity-50"
                >
                  {busy === 'send' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Send now
                </button>
                <button
                  type="button"
                  disabled={busy !== null || !toEmail.trim() || roleAddress}
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

function LeadScoreBadge({ prospect: p }: { prospect: OutreachProspect }) {
  if (p.lead_score === null || p.lead_score === undefined) return null;
  const tone = p.lead_score >= 60 ? 'bg-emerald-50 text-emerald-700' : p.lead_score >= 40 ? 'bg-gray-100 text-gray-600' : 'bg-amber-50 text-amber-700';
  return (
    <span title={(p.lead_signals?.reasons ?? []).join('\n')} className={`cursor-help rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${tone}`}>
      Score {p.lead_score}
    </span>
  );
}

function ContactBadge({ prospect: p }: { prospect: OutreachProspect }) {
  if (p.contact_verified === 'valid') {
    return <span className="inline-flex items-center gap-0.5 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700"><BadgeCheck className="h-3 w-3" /> Checked</span>;
  }
  if (p.contact_verified === 'catch_all') {
    return <span title="Their mail server accepts any address, so Hunter cannot confirm this one" className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">Likely, not confirmed</span>;
  }
  if (p.contact_email && isRoleAddress(p.contact_email)) {
    return <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">Shared inbox</span>;
  }
  if (p.contact_source === 'manual') return <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">Added by hand</span>;
  return null;
}

/** The Hunter key for decision-maker lookups, on the Settings tab. */
function HunterSection() {
  const showToast = useToast();
  const [status, setStatus] = useState<HunterStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => getHunterStatus().then(setStatus, () => setStatus({ connected: false })), []);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      showToast(done);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const a = status?.account;
  const left = a
    ? a.credits
      ? `${a.credits.available - a.credits.used} of ${a.credits.available} credits left`
      : `${a.searches.available - a.searches.used} of ${a.searches.available} searches and ${a.verifications.available - a.verifications.used} of ${a.verifications.available} checks left`
    : null;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">Decision-maker lookup (Hunter)</h2>
          <p className="mt-1 text-xs text-gray-500">
            Finds the founder or marketing lead at each store and checks their address, so emails never go to a support inbox.
            Each lookup uses one search and up to two checks.
          </p>
          {status?.connected && (
            <p className="mt-2 text-xs text-gray-600">
              Connected{a?.email ? ` as ${a.email}` : ''}{a?.plan ? ` (${a.plan})` : ''}.{left ? ` ${left} this month` : ''}
              {a?.reset_date ? `, resets ${new Date(a.reset_date).toLocaleDateString()}` : ''}.
              {status.error && <span className="text-amber-700"> {status.error}</span>}
            </p>
          )}
        </div>
        {status?.connected && (
          <button
            type="button"
            disabled={busy}
            onClick={() => { if (window.confirm('Disconnect Hunter?')) void act(disconnectHunter, 'Hunter disconnected'); }}
            className="text-xs text-gray-400 hover:text-gray-700"
          >
            Disconnect
          </button>
        )}
      </div>
      {status && !status.connected && (
        <form
          className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => { await connectHunter(key); setKey(''); }, 'Hunter connected');
          }}
        >
          <input value={key} onChange={(e) => setKey(e.target.value)} type="password" autoComplete="off" placeholder="Hunter API key" className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm" />
          <button type="submit" disabled={busy || !key.trim()} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand-primary px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-primary-dark disabled:opacity-50">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} Connect
          </button>
          <p className="text-[11px] text-gray-400 sm:col-span-2">
            Copy it from hunter.io/api-keys (the free plan is enough to start). We check it, store it encrypted, and it is never shown again.
          </p>
        </form>
      )}
    </section>
  );
}

/**
 * The signature under every outreach email follows his Gmail (Emil, 2026-11-02):
 * read from the newest email he wrote there, on demand and once a day, never
 * typed here. Folded away by default: it is checked, not edited.
 */
function SignatureSection({ status, onChanged }: { status: OutreachSendStatus | null; onChanged: () => Promise<void> }) {
  const showToast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsGoogle, setNeedsGoogle] = useState(false);
  const sig = status?.settings.signature_html ?? '';
  const synced = status?.settings.signature_synced_at;

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const r = await syncSignature();
      await onChanged();
      setNeedsGoogle(Boolean(r.needs_reconnect));
      if (r.ok) {
        showToast(r.changed ? 'Signature updated from Gmail' : 'Signature is already up to date');
        setOpen(true);
      } else if (!r.needs_reconnect) {
        showToast(r.error ?? 'Could not read your Gmail');
      }
    } finally {
      setBusy(false);
    }
  }, [onChanged, showToast]);

  // Back from Google sign-in: read the signature straight away, then tidy the address bar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('gmail');
    if (!outcome) return;
    ['gmail', 'gmail_email', 'gmail_detail'].forEach((k) => params.delete(k));
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    if (outcome === 'connected') void refresh();
    else showToast('Google was not connected. Try again.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center gap-3 px-5 py-4">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <div className="min-w-0 flex-1">
            <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-900">
              Signature
              {sig ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                  <CheckCircle2 className="h-3 w-3" /> From your Gmail
                </span>
              ) : (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">Not found yet</span>
              )}
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Added under every outreach email. It follows the signature in your Gmail and refreshes once a day
              {synced ? `; last checked ${new Date(synced).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}.
            </p>
          </div>
          <ChevronDown className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        <button
          type="button"
          disabled={busy || !status?.mailbox}
          onClick={refresh}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Refresh from Gmail
        </button>
      </div>
      {needsGoogle && (
        <div className="flex flex-wrap items-center gap-3 border-t border-amber-100 bg-amber-50/60 px-5 py-3">
          <p className="min-w-0 flex-1 text-xs text-amber-800">
            To use the signature set in your Gmail, connect your Google account once. It only lets the app read your Gmail
            settings and send email, never read your mail.
          </p>
          <button
            type="button"
            onClick={() => void connectGmail()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-primary-dark"
          >
            <PlugZap className="h-3.5 w-3.5" /> Connect Google
          </button>
        </div>
      )}
      {open && (
        <div className="border-t border-gray-100 bg-gray-50/60 px-5 py-4">
          {sig ? (
            /* Sandboxed: the signature's HTML is shown, never run. */
            <iframe
              title="Signature preview"
              sandbox=""
              srcDoc={`<body style="margin:0;padding:12px;font-family:Arial,sans-serif;background:#fff">${sig}</body>`}
              className="h-56 w-full max-w-xl rounded-lg border border-gray-200 bg-white"
            />
          ) : (
            <p className="text-xs text-gray-500">
              No signature yet. Set one in Gmail (Settings, General, Signature), then refresh.
            </p>
          )}
          <p className="mt-2 text-[11px] text-gray-400">To change it, edit your signature in Gmail. It shows up here by tomorrow, or straight away with Refresh from Gmail.</p>
        </div>
      )}
    </section>
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
                    : p?.status === 'replied' || p?.status === 'unsubscribed'
                      ? (p.reply_kind ? REPLY_LABELS[p.reply_kind] : p.status === 'unsubscribed' ? 'Said no' : 'Replied')
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
    auto_pipeline: false,
    auto_audits_per_day: 3,
    min_lead_score: 40,
    hubspot_log: true,
    reply_alerts: true,
    hot_lead_views: 3,
    about_intro: '',
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
      auto_pipeline: settings.auto_pipeline,
      auto_audits_per_day: settings.auto_audits_per_day,
      min_lead_score: settings.min_lead_score,
      hubspot_log: settings.hubspot_log,
      reply_alerts: settings.reply_alerts,
      hot_lead_views: settings.hot_lead_views,
      about_intro: settings.about_intro ?? '',
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
      form.auto_pipeline !== settings.auto_pipeline ||
      form.auto_audits_per_day !== settings.auto_audits_per_day ||
      form.min_lead_score !== settings.min_lead_score ||
      form.hubspot_log !== settings.hubspot_log ||
      form.reply_alerts !== settings.reply_alerts ||
      form.hot_lead_views !== settings.hot_lead_views ||
      form.about_intro !== (settings.about_intro ?? ''));

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

      <HunterSection />

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-900">Lead quality and auto-pipeline</h2>
        <p className="mt-1 text-xs text-gray-500">
          Every store gets a lead score (0-100) when it is checked: traffic rank, catalogue size, paid tools like Attentive or
          Recharge, and whether it sells in USD. Hover a score on the Prospects tab to see why.
        </p>
        <div className="mt-4">
          <ToggleRow
            title="Run the pipeline on its own"
            description="Takes the best stores from To audit each day: finds the decision-maker (a store with no one to email is skipped), runs the audit and drafts the email. Drafts wait in Ready to send; nothing goes out until you send or queue it."
            checked={form.auto_pipeline}
            onChange={(v) => setForm((f) => ({ ...f, auto_pipeline: v }))}
          />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {num('auto_audits_per_day', 'Stores to audit per day', 0, 10, 'New York days, two at a time.')}
          {num('min_lead_score', 'Lowest lead score to keep', 0, 100, 'Checked stores under this are skipped. 40 is a fair start.')}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-gray-900">Replies and HubSpot</h2>
        <p className="mt-1 text-xs text-gray-500">
          Every reply is read and sorted. Anyone who answers stops getting follow-ups; anyone who says no goes on the
          do-not-contact list for good{status?.suppressed ? ` (${status.suppressed} so far)` : ''}. An out-of-office lets the follow-up go ahead.
        </p>
        <div className="mt-4">
          <ToggleRow
            title="Email me when someone replies"
            description={'Interested, a question, a referral or "not now", with what they said and their report.'}
            checked={form.reply_alerts}
            onChange={(v) => setForm((f) => ({ ...f, reply_alerts: v }))}
          />
        </div>
        <div className="mt-3 max-w-xs">
          {num('hot_lead_views', 'Email me when someone opens their report this many times', 0, 20, 'Without replying. One visit counts once; your own looks never count. 0 turns it off.')}
        </div>
        <div className="mt-4">
          <ToggleRow
            title="Log them in HubSpot"
            description="Once emailed: the company and contact (owned by you), every email both ways, and their lead status from the reply."
            checked={form.hubspot_log}
            onChange={(v) => setForm((f) => ({ ...f, hubspot_log: v }))}
          >
            {status?.hubspot && !status.hubspot.connected && <p className="mt-1.5 text-xs text-amber-700">HubSpot is not connected.</p>}
            {status?.hubspot?.missing_scopes && status.hubspot.missing_scopes.length > 0 && (
              <p className="mt-1.5 text-xs text-amber-700">The HubSpot app is missing: {status.hubspot.missing_scopes.join(', ')}.</p>
            )}
          </ToggleRow>
        </div>
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
        <h2 className="text-sm font-semibold text-gray-900">Booking link and report note</h2>
        <label className="mt-3 block text-xs text-gray-500">
          Booking link (used in follow-ups and on their report)
          <input
            value={form.booking_url}
            onChange={(e) => setForm((f) => ({ ...f, booking_url: e.target.value }))}
            placeholder="https://calendly.com/..."
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-900"
          />
        </label>
        <label className="mt-4 block text-xs text-gray-500">
          Who made this (a few plain lines at the end of their report; empty hides it)
          <textarea
            value={form.about_intro}
            onChange={(e) => setForm((f) => ({ ...f, about_intro: e.target.value }))}
            rows={3}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800"
          />
        </label>
      </section>

      <SignatureSection status={status} onChanged={onChanged} />

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
