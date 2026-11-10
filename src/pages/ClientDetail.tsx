import { useLocation, useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Globe,
  Mail,
  User,
  FileText,
  FileSignature,
  Plus,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Loader2,
  KeyRound,
  Trash2,
} from 'lucide-react';
import TopBar from '../components/layout/TopBar';
import StatusBadge from '../components/ui/StatusBadge';
import SiteFavicon from '../components/ui/SiteFavicon';
import { SkeletonClientDetail } from '../components/ui/Skeleton';
import { IndustrySelectWithCustom } from '../components/ui/IndustrySelect';
import { useAuth } from '../contexts/AuthContext';
import { formatCurrency } from '../lib/revenue-calculator';
import AuditStatusBadge from '../components/ui/AuditStatusBadge';
import { useEffect, useState } from 'react';
import type { Audit, Client, Proposal } from '../lib/types';
import { getClient, listAuditsByClient, updateClient } from '../lib/db';
import { listProposalsByClient } from '../lib/proposals-db';
import { deriveProposalStatus } from '../lib/proposal-status';
import { proposalValue } from '../lib/proposal-pricing';
import { canAccessArea } from '../lib/access';
import { supabase } from '../lib/supabase';
import Modal from '../components/ui/Modal';
import { KlaviyoApiKeyHelpTrigger } from '../components/klaviyo/KlaviyoApiKeyHelpModal';

export default function ClientDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, hasRole } = useAuth();
  const showProposals = canAccessArea(user, 'proposals');

  const [client, setClient] = useState<Client | null>(null);
  const [clientAudits, setClientAudits] = useState<Audit[]>([]);
  const [clientProposals, setClientProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [newApiKey, setNewApiKey] = useState('');
  const [keySaving, setKeySaving] = useState(false);
  const [keyMsg, setKeyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailDraft, setEmailDraft] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [editingWebsite, setEditingWebsite] = useState(false);
  const [websiteDraft, setWebsiteDraft] = useState('');
  const [websiteSaving, setWebsiteSaving] = useState(false);
  const [websiteError, setWebsiteError] = useState('');
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletingAudit, setDeletingAudit] = useState<Audit | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!id) return;
    (async () => {
      try {
        setLoading(true);
        setError('');
        const [c, a, p] = await Promise.all([getClient(id), listAuditsByClient(id), listProposalsByClient(id)]);
        if (cancelled) return;
        setClient(c);
        setClientAudits(a);
        setClientProposals(p);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load client');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return (
      <div>
        <TopBar title="Client" />
        <SkeletonClientDetail />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <TopBar title="Client" />
        <div className="p-8">
          <div className="text-sm text-red-600 bg-red-50 px-4 py-2.5 rounded-lg">{error}</div>
          <button
            onClick={() => navigate('/clients')}
            className="mt-4 text-sm text-brand-primary font-medium hover:underline"
          >
            Back to Clients
          </button>
        </div>
      </div>
    );
  }

  if (!client) {
    return (
      <div>
        <TopBar title="Client Not Found" />
        <div className="p-8 text-center">
          <p className="text-gray-500">This client could not be found.</p>
          <button
            onClick={() => navigate('/clients')}
            className="mt-4 text-sm text-brand-primary font-medium hover:underline"
          >
            Back to Clients
          </button>
        </div>
      </div>
    );
  }

  const hasApiConnection = Boolean((client as Client & { klaviyo_connected?: boolean }).klaviyo_connected);

  const handleSaveApiKey = async () => {
    if (!client || !newApiKey.trim()) return;
    setKeySaving(true);
    setKeyMsg(null);
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('klaviyo_connect_client', {
        body: { client_id: client.id, api_key: newApiKey.trim() },
      });
      if (fnErr) throw fnErr;
      if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Failed to connect Klaviyo');
      const klaviyoWebsite = typeof data?.account?.websiteUrl === 'string' ? data.account.websiteUrl.trim() : '';
      let nextWebsite = client.website_url?.trim() ?? '';
      if (klaviyoWebsite && !nextWebsite) {
        const updated = await updateClient(client.id, { website_url: klaviyoWebsite });
        nextWebsite = updated.website_url;
      }
      setKeyMsg({ ok: true, text: 'API key updated successfully.' });
      setEditingKey(false);
      setNewApiKey('');
      setClient(prev => prev ? { ...prev, klaviyo_connected: true, website_url: nextWebsite } as Client : prev);
    } catch (e: unknown) {
      setKeyMsg({ ok: false, text: e instanceof Error ? e.message : 'Failed to update API key' });
    } finally {
      setKeySaving(false);
    }
  };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const handleSaveName = async () => {
    if (!client) return;
    const trimmed = nameDraft.trim();
    setNameSaving(true);
    try {
      await updateClient(client.id, { name: trimmed || client.company_name });
      setClient(prev => (prev ? { ...prev, name: trimmed || client.company_name } : prev));
      setEditingName(false);
    } catch {
      // keep the field open so the user can retry
    } finally {
      setNameSaving(false);
    }
  };

  const handleSaveEmail = async () => {
    if (!client) return;
    const trimmed = emailDraft.trim();
    if (trimmed && !EMAIL_RE.test(trimmed)) {
      setEmailError('Please enter a valid email address.');
      return;
    }
    setEmailSaving(true);
    setEmailError('');
    try {
      await updateClient(client.id, { email: trimmed });
      setClient(prev => (prev ? { ...prev, email: trimmed } : prev));
      setEditingEmail(false);
    } catch (e: unknown) {
      setEmailError(e instanceof Error ? e.message : 'Failed to save email');
    } finally {
      setEmailSaving(false);
    }
  };

  const handleSaveWebsite = async () => {
    if (!client) return;
    setWebsiteSaving(true);
    setWebsiteError('');
    try {
      const updated = await updateClient(client.id, { website_url: websiteDraft.trim() });
      setClient(prev => (prev ? { ...prev, website_url: updated.website_url } : prev));
      setEditingWebsite(false);
    } catch (e: unknown) {
      setWebsiteError(e instanceof Error ? e.message : 'Failed to save website');
    } finally {
      setWebsiteSaving(false);
    }
  };

  const firstAuditDate = clientAudits.length
    ? new Date(
      clientAudits
        .map(a => new Date(a.created_at).getTime())
        .reduce((min, t) => Math.min(min, t), Infinity),
    ).toLocaleDateString()
    : '—';

  const totalProposalValue = clientProposals.reduce((sum, p) => sum + proposalValue(p), 0);
  const wonProposalsCount = clientProposals.filter(p => deriveProposalStatus(p) === 'won').length;

  return (
    <div>
      <TopBar
        title={client.company_name}
        subtitle={client.website_url || ' '}
        leadingIcon={<SiteFavicon url={client.website_url} size="md" />}
        actions={
          <div className="flex items-center gap-2">
            {showProposals && (
              <button
                onClick={() => navigate('/proposals/new', { state: { clientId: client.id, backgroundLocation: location } })}
                className="flex items-center gap-2 px-4 py-2 border border-gray-200 bg-white text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
              >
                <FileSignature className="w-4 h-4" />
                New Proposal
              </button>
            )}
            <button
              onClick={() => navigate('/audits/new', { state: { clientId: client.id, backgroundLocation: location } })}
              className="flex items-center gap-2 px-4 py-2 gradient-bg text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              New Audit
            </button>
          </div>
        }
      />
      <Modal
        open={deleteConfirmOpen}
        title="Delete audit?"
        onClose={() => {
          if (deleting) return;
          setDeleteConfirmOpen(false);
          setDeletingAudit(null);
        }}
        className="max-w-lg"
      >
        <div className="p-5">
          <p className="text-sm text-gray-700">
            {deletingAudit
              ? `Delete “${deletingAudit.title}”? This action cannot be undone.`
              : 'Delete this audit? This action cannot be undone.'}
          </p>
          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={deleting}
              onClick={() => {
                setDeleteConfirmOpen(false);
                setDeletingAudit(null);
              }}
              className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deleting || !deletingAudit}
              onClick={async () => {
                if (!deletingAudit) return;
                try {
                  setDeleting(true);
                  const { data, error: fnError } = await supabase.functions.invoke('admin_delete_audit', {
                    body: { audit_id: deletingAudit.id },
                  });
                  if (fnError) throw fnError;
                  if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Failed to delete audit');
                  setClientAudits(prev => prev.filter(a => a.id !== deletingAudit.id));
                  setDeleteConfirmOpen(false);
                  setDeletingAudit(null);
                } catch (err: unknown) {
                  alert(err instanceof Error ? err.message : 'Failed to delete audit');
                } finally {
                  setDeleting(false);
                }
              }}
              className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {deleting ? 'Deleting…' : 'Delete audit'}
            </button>
          </div>
        </div>
      </Modal>

      <div className="p-8 animate-fade-in">
        <button
          onClick={() => navigate('/clients')}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Clients
        </button>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-white rounded-xl p-6 card-shadow">
              <h2 className="text-base font-semibold text-gray-900 mb-4">Client Details</h2>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Company</p>
                  <div className="flex items-center gap-2">
                    <SiteFavicon url={client.website_url} />
                    <p className="text-sm text-gray-900">{client.company_name}</p>
                  </div>
                </div>
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Contact Name</p>
                  {editingName ? (
                    <div className="space-y-1.5">
                      <input
                        type="text"
                        autoFocus
                        value={nameDraft}
                        onChange={e => setNameDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSaveName();
                          if (e.key === 'Escape') setEditingName(false);
                        }}
                        placeholder="Jane Smith"
                        className="w-full max-w-[220px] rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleSaveName}
                          disabled={nameSaving}
                          className="text-xs font-medium text-brand-primary hover:underline disabled:opacity-50"
                        >
                          {nameSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingName(false)}
                          disabled={nameSaving}
                          className="text-xs text-gray-500 hover:text-gray-700"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setNameDraft(client.name === client.company_name ? '' : client.name); setEditingName(true); }}
                      className="flex items-center gap-1.5 text-sm hover:underline text-left"
                    >
                      <User className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                      {client.name && client.name !== client.company_name ? (
                        <span className="text-gray-900">{client.name}</span>
                      ) : (
                        <span className="text-gray-400">Add name</span>
                      )}
                    </button>
                  )}
                </div>
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Contact Email</p>
                  {editingEmail ? (
                    <div className="space-y-1.5">
                      <input
                        type="email"
                        autoFocus
                        value={emailDraft}
                        onChange={e => setEmailDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSaveEmail();
                          if (e.key === 'Escape') { setEditingEmail(false); setEmailError(''); }
                        }}
                        placeholder="jane@company.com"
                        className="w-full max-w-[220px] rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
                      />
                      {emailError && <p className="text-xs text-red-600">{emailError}</p>}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleSaveEmail}
                          disabled={emailSaving}
                          className="text-xs font-medium text-brand-primary hover:underline disabled:opacity-50"
                        >
                          {emailSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setEditingEmail(false); setEmailError(''); }}
                          disabled={emailSaving}
                          className="text-xs text-gray-500 hover:text-gray-700"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setEmailDraft(client.email || ''); setEditingEmail(true); setEmailError(''); }}
                      className="flex items-center gap-1.5 text-sm hover:underline"
                    >
                      <Mail className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                      {client.email ? (
                        <span className="text-gray-900">{client.email}</span>
                      ) : (
                        <span className="text-gray-400">Add email</span>
                      )}
                    </button>
                  )}
                </div>
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Industry</p>
                  <IndustrySelectWithCustom
                    value={client.industry || ''}
                    onValueChange={async (v) => {
                      setClient(prev => prev ? { ...prev, industry: v } : prev);
                      try { await updateClient(client.id, { industry: v }); } catch { /* ignore */ }
                    }}
                    iconSize="sm"
                    triggerClassName="h-8 text-sm w-full max-w-[200px]"
                  />
                </div>
                <div>
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Website</p>
                  {editingWebsite ? (
                    <div className="space-y-1.5">
                      <input
                        type="text"
                        autoFocus
                        value={websiteDraft}
                        onChange={e => setWebsiteDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSaveWebsite();
                          if (e.key === 'Escape') { setEditingWebsite(false); setWebsiteError(''); }
                        }}
                        placeholder="lazyleaf.com"
                        className="w-full max-w-[260px] rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
                      />
                      {websiteError && <p className="text-xs text-red-600">{websiteError}</p>}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleSaveWebsite}
                          disabled={websiteSaving}
                          className="text-xs font-medium text-brand-primary hover:underline disabled:opacity-50"
                        >
                          {websiteSaving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setEditingWebsite(false); setWebsiteError(''); }}
                          disabled={websiteSaving}
                          className="text-xs text-gray-500 hover:text-gray-700"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setWebsiteDraft(client.website_url || ''); setEditingWebsite(true); setWebsiteError(''); }}
                      className="flex items-center gap-1.5 text-sm hover:underline text-left"
                    >
                      <Globe className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                      {client.website_url ? (
                        <span className="text-brand-primary">{client.website_url}</span>
                      ) : (
                        <span className="text-gray-400">Add website</span>
                      )}
                    </button>
                  )}
                </div>
              </div>
              {client.notes && (
                <div className="mt-4 pt-4 border-t border-gray-50">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">Notes</p>
                  <p className="text-sm text-gray-700">{client.notes}</p>
                </div>
              )}
            </div>

            <div className="bg-white rounded-xl card-shadow">
              <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
                <h2 className="text-base font-semibold text-gray-900">Audit History</h2>
                <span className="text-xs text-gray-400">{clientAudits.length} audits</span>
              </div>
              {clientAudits.length === 0 ? (
                <div className="p-8 text-center">
                  <FileText className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                  <p className="text-sm text-gray-500">No audits yet for this client.</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {clientAudits.map(audit => (
                    <div
                      key={audit.id}
                      onClick={() => navigate(`/audits/${audit.id}`)}
                      className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50/50 transition-colors text-left cursor-pointer"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <SiteFavicon url={client.website_url} />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{audit.title}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {new Date(audit.created_at).toLocaleDateString()} &middot; {audit.audit_method === 'api' ? 'API Connected' : 'Screenshot Based'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0 ml-4">
                        <span className="text-sm font-semibold text-emerald-700">
                          {audit.audit_type === 'web' ? '—' : formatCurrency(audit.total_revenue_opportunity)}
                        </span>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={audit.status} />
                          <AuditStatusBadge audit={audit} />
                        </div>
                        {hasRole('admin') && (
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation();
                              setDeletingAudit(audit);
                              setDeleteConfirmOpen(true);
                            }}
                            className="p-1.5 rounded hover:bg-red-50 transition-colors"
                            title="Delete audit"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-gray-400 hover:text-red-600" />
                          </button>
                        )}
                        <a
                          href={`/audits/${audit.id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="p-1.5 rounded hover:bg-gray-100 transition-colors inline-flex"
                          title="Open audit in new tab"
                        >
                          <ExternalLink className="w-3.5 h-3.5 text-gray-400" />
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {showProposals && (
              <div className="bg-white rounded-xl card-shadow">
                <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
                  <h2 className="text-base font-semibold text-gray-900">Proposals</h2>
                  <span className="text-xs text-gray-400">{clientProposals.length} proposals</span>
                </div>
                {clientProposals.length === 0 ? (
                  <div className="p-8 text-center">
                    <FileSignature className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                    <p className="text-sm text-gray-500">No proposals yet for this client.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-gray-50">
                    {clientProposals.map(proposal => (
                      <div
                        key={proposal.id}
                        onClick={() => navigate(`/proposals/${proposal.id}`)}
                        className="w-full flex items-center justify-between px-6 py-4 hover:bg-gray-50/50 transition-colors text-left cursor-pointer"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {proposal.title || 'Untitled proposal'}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5 tabular-nums">
                            ECD-{String(proposal.proposal_number).padStart(4, '0')}
                            {' · '}
                            {new Date(proposal.updated_at).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="flex items-center gap-3 shrink-0 ml-4">
                          <span className="text-sm font-semibold text-gray-900">
                            {formatCurrency(proposalValue(proposal))}
                          </span>
                          <StatusBadge status={deriveProposalStatus(proposal)} />
                          <a
                            href={`/proposals/${proposal.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={e => e.stopPropagation()}
                            className="p-1.5 rounded hover:bg-gray-100 transition-colors inline-flex"
                            title="Open proposal in new tab"
                          >
                            <ExternalLink className="w-3.5 h-3.5 text-gray-400" />
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="space-y-6">
            <div className="bg-white rounded-xl p-5 card-shadow">
              <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                <h3 className="text-sm font-semibold text-gray-900">API Connection</h3>
                <KlaviyoApiKeyHelpTrigger className="inline-flex w-fit shrink-0 items-center gap-1.5 text-xs font-medium text-brand-primary transition-colors hover:text-brand-primary-dark hover:underline" />
              </div>
              <div className="flex items-center gap-2 mb-3">
                {hasApiConnection ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    <span className="text-sm text-emerald-700 font-medium">Connected</span>
                  </>
                ) : (
                  <>
                    <XCircle className="w-4 h-4 text-gray-300" />
                    <span className="text-sm text-gray-500">Not Connected</span>
                  </>
                )}
              </div>

              {keyMsg && (
                <div className={`text-xs px-3 py-2 rounded-lg mb-3 ${keyMsg.ok ? 'text-emerald-700 bg-emerald-50 border border-emerald-100' : 'text-red-700 bg-red-50 border border-red-100'}`}>
                  {keyMsg.text}
                </div>
              )}

              {editingKey ? (
                <div className="space-y-2">
                  <input
                    type="password"
                    value={newApiKey}
                    onChange={e => setNewApiKey(e.target.value)}
                    placeholder="pk_..."
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs font-mono focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSaveApiKey}
                      disabled={keySaving || !newApiKey.trim()}
                      className="flex items-center gap-1.5 px-3 py-1.5 gradient-bg text-white text-xs font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40"
                    >
                      {keySaving && <Loader2 className="w-3 h-3 animate-spin" />}
                      {keySaving ? 'Saving...' : 'Save Key'}
                    </button>
                    <button
                      onClick={() => { setEditingKey(false); setNewApiKey(''); setKeyMsg(null); }}
                      disabled={keySaving}
                      className="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => { setEditingKey(true); setKeyMsg(null); }}
                  className="flex items-center gap-1.5 text-xs text-brand-primary font-medium hover:underline"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  {hasApiConnection ? 'Update API Key' : 'Connect API Key'}
                </button>
              )}
            </div>

            <div className="bg-white rounded-xl p-5 card-shadow">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Quick Stats</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500">Total Audits</span>
                  <span className="text-sm font-semibold text-gray-900">{clientAudits.length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500">Total Rev Opportunity</span>
                  <span className="text-sm font-semibold text-emerald-700">
                    {formatCurrency(clientAudits.reduce((s, a) => s + a.total_revenue_opportunity, 0))}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-500">First Audit</span>
                  <span className="text-sm text-gray-900">
                    {firstAuditDate}
                  </span>
                </div>
                {showProposals && clientProposals.length > 0 && (
                  <>
                    <div className="pt-3 border-t border-gray-50" />
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-500">Total Proposals</span>
                      <span className="text-sm font-semibold text-gray-900">{clientProposals.length}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-500">Proposal Value</span>
                      <span className="text-sm font-semibold text-emerald-700">
                        {formatCurrency(totalProposalValue)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-gray-500">Proposals Won</span>
                      <span className="text-sm text-gray-900">{wonProposalsCount}</span>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
