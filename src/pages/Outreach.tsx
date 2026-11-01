import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, ExternalLink, Loader2, Mail, Play, RefreshCw, Send, Sparkles, X } from 'lucide-react';
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
  type OutreachProspect,
  type ScreenResult,
} from '../lib/outreach';

// Outreach, step 1 (Emil, 2026-11-01): see src/lib/outreach.ts. Emil approves and
// sends every email himself for now; sending on autopilot comes later.

const GROUPS: Array<{ key: string; title: string; note: string; match: (p: OutreachProspect) => boolean }> = [
  { key: 'ready', title: 'Ready to send', note: 'Check the email, add who it goes to, send it from Gmail, then mark it sent.', match: (p) => p.status === 'ready' },
  { key: 'auditing', title: 'Auditing', note: 'The audit runs on the server and takes a few minutes. Draft the email once it is done.', match: (p) => p.status === 'auditing' || p.status === 'failed' },
  { key: 'new', title: 'To audit', note: 'Passed the checks: not a client, not in HubSpot, on Shopify.', match: (p) => p.status === 'new' },
  { key: 'sent', title: 'Sent', note: '', match: (p) => ['sent', 'replied', 'unsubscribed'].includes(p.status) },
  { key: 'skipped', title: 'Skipped', note: 'Never audited or emailed.', match: (p) => p.status === 'skipped' },
];

export default function Outreach() {
  const { user } = useAuth();
  const showToast = useToast();
  const [prospects, setProspects] = useState<OutreachProspect[] | null>(null);
  const [paste, setPaste] = useState('');
  const [screening, setScreening] = useState(false);
  const [lastScreen, setLastScreen] = useState<ScreenResult[] | null>(null);

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
                  <ProspectCard key={p.id} prospect={p} userId={user?.id ?? ''} onChanged={load} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function ProspectCard({ prospect: p, userId, onChanged }: { prospect: OutreachProspect; userId: string; onChanged: () => Promise<void> }) {
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
          {p.sent_at && <p className="mt-1 text-xs text-gray-500">Sent {new Date(p.sent_at).toLocaleDateString()}{p.contact_email ? ` to ${p.contact_email}` : ''}</p>}
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
          {['new', 'auditing', 'ready', 'failed'].includes(p.status) && (
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
            <a
              href={toEmail.trim() ? gmailComposeUrl(toEmail.trim(), subject, body) : undefined}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => { if (!toEmail.trim()) { e.preventDefault(); showToast('Add their email first'); } else void saveEdits(); }}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white ${toEmail.trim() ? 'bg-brand-primary hover:bg-brand-primary-dark' : 'bg-brand-primary/40'}`}
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
