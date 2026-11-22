import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Users, Plus, Search, ArrowRight, Globe, Calendar, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import TopBar from '../components/layout/TopBar';
import EmptyState from '../components/ui/EmptyState';
import SiteFavicon from '../components/ui/SiteFavicon';
import { SkeletonClientCards } from '../components/ui/Skeleton';
import { useAuth } from '../contexts/AuthContext';
import { listAudits, listClients } from '../lib/db';
import type { Audit, Client } from '../lib/types';
import { supabase } from '../lib/supabase';
import Modal from '../components/ui/Modal';
import HoverTooltip from '../components/ui/HoverTooltip';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../components/ui/select';

const PAGE_SIZE = 102;

type SortOption = 'newest' | 'oldest' | 'name_asc' | 'name_desc';

const SORT_LABELS: Record<SortOption, string> = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  name_asc: 'Name (A to Z)',
  name_desc: 'Name (Z to A)',
};

function syncRelativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const min = Math.round((Date.now() - then) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

/** Compact "Sync now" control for the Revenue Desk client sync (HubSpot until 2026-11-22); detail in a tooltip. */
function CrmSyncButton() {
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('hubspot_sync_state')
      .select('last_synced_at')
      .eq('id', 'default')
      .maybeSingle();
    setLastSynced((data as { last_synced_at: string | null } | null)?.last_synced_at ?? null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const syncNow = async () => {
    setSyncing(true);
    setError('');
    try {
      const { data, error: fnError } = await supabase.functions.invoke('crm_client_sync', { body: {} });
      if (fnError) throw fnError;
      if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Sync failed');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const tooltip = error
    ? `Revenue Desk sync failed: ${error}`
    : `Auto-syncs from Revenue Desk (the ECD CRM) every 15 minutes · last synced ${syncRelativeTime(lastSynced)}`;

  return (
    <HoverTooltip label={tooltip} align="end">
      <button
        type="button"
        onClick={syncNow}
        disabled={syncing}
        className="inline-flex h-[42px] items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
      >
        {syncing ? (
          <RefreshCw className="h-3.5 w-3.5 animate-spin text-gray-400" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5 shrink-0 text-gray-400" />
        )}
        {syncing ? 'Syncing…' : 'Sync now'}
      </button>
    </HoverTooltip>
  );
}

export default function Clients() {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasRole } = useAuth();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortOption>('newest');
  const [page, setPage] = useState(1);

  const [clients, setClients] = useState<Client[]>([]);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletingClient, setDeletingClient] = useState<Client | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError('');
        const [c, a] = await Promise.all([listClients(), listAudits()]);
        if (cancelled) return;
        setClients(c);
        setAudits(a);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load clients');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [location.key]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const matched = clients.filter(
      c =>
        c.name.toLowerCase().includes(q) ||
        c.company_name.toLowerCase().includes(q) ||
        (c.website_url ?? '').toLowerCase().includes(q),
    );
    const sorted = [...matched].sort((a, b) => {
      switch (sort) {
        case 'oldest':
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case 'name_asc':
          return a.company_name.localeCompare(b.company_name);
        case 'name_desc':
          return b.company_name.localeCompare(a.company_name);
        default:
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
    });
    return sorted;
  }, [clients, search, sort]);

  // Reset to page 1 whenever the filtered/sorted set changes shape.
  useEffect(() => {
    setPage(1);
  }, [search, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageClients = useMemo(
    () => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filtered, page],
  );

  return (
    <div>
      <TopBar
        title="Clients"
        subtitle={`${clients.length} total clients`}
        actions={
          <button
            onClick={() => navigate('/clients/new', { state: { backgroundLocation: location } })}
            className="flex items-center gap-2 px-4 py-2 gradient-bg text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
          >
            <Plus className="w-4 h-4" />
            Add Client
          </button>
        }
      />

      <div className="p-8 animate-fade-in">
        <Modal
          open={deleteConfirmOpen}
          title="Delete client?"
          onClose={() => {
            if (deleting) return;
            setDeleteConfirmOpen(false);
            setDeletingClient(null);
          }}
          className="max-w-lg"
        >
          <div className="p-5">
            <p className="text-sm text-gray-700">
              {deletingClient
                ? `Delete “${deletingClient.company_name}”? This will also delete all audits for this client.`
                : 'Delete this client? This will also delete its audits.'}
            </p>
            <div className="mt-5 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => {
                  setDeleteConfirmOpen(false);
                  setDeletingClient(null);
                }}
                className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting || !deletingClient}
                onClick={async () => {
                  if (!deletingClient) return;
                  try {
                    setDeleting(true);
                    const { data, error } = await supabase.functions.invoke('admin_delete_client', {
                      body: { client_id: deletingClient.id },
                    });
                    if (error) throw error;
                    if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Failed to delete client');
                    setClients(prev => prev.filter(c => c.id !== deletingClient.id));
                    setAudits(prev => prev.filter(a => a.client_id !== deletingClient.id));
                    setDeleteConfirmOpen(false);
                    setDeletingClient(null);
                  } catch (err: unknown) {
                    alert(err instanceof Error ? err.message : 'Failed to delete client');
                  } finally {
                    setDeleting(false);
                  }
                }}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? 'Deleting…' : 'Delete client'}
              </button>
            </div>
          </div>
        </Modal>

        <div className="mb-6 flex flex-wrap items-center gap-3">
          <div className="relative max-w-md flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search clients by name..."
              className="w-full pl-10 pr-4 py-2.5 bg-white border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
            />
          </div>
          {/* No sort icon in the trigger: it wrapped onto its own line above the
              label at some widths and the chevron already says "dropdown". */}
          <Select value={sort} onValueChange={v => setSort(v as SortOption)}>
            <SelectTrigger className="w-auto min-w-[168px] h-[42px] gap-2">
              <SelectValue>{SORT_LABELS[sort]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as SortOption[]).map(opt => (
                <SelectItem key={opt} value={opt}>
                  <SelectItemText>{SORT_LABELS[opt]}</SelectItemText>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto">
            <CrmSyncButton />
          </div>
        </div>

        {error && (
          <div className="mb-6 text-sm text-red-600 bg-red-50 px-4 py-2.5 rounded-lg">
            {error}
          </div>
        )}

        {loading ? (
          <SkeletonClientCards />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No clients yet"
            description="Add your first client to start running audits."
            action={
              <button
                onClick={() => navigate('/clients/new', { state: { backgroundLocation: location } })}
                className="flex items-center gap-2 px-5 py-2.5 gradient-bg text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
              >
                <Plus className="w-4 h-4" />
                Add First Client
              </button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {pageClients.map(client => {
              const clientAudits = audits.filter(a => a.client_id === client.id);
              const lastAudit = clientAudits[0];
              return (
                <button
                  key={client.id}
                  onClick={() => navigate(`/clients/${client.id}`)}
                  className="bg-white rounded-xl p-5 card-shadow hover:card-shadow-hover transition-all text-left group"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-start gap-3 min-w-0">
                      <SiteFavicon url={client.website_url} />
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-gray-900 group-hover:text-brand-primary transition-colors truncate">
                          {client.company_name}
                        </h3>
                        <p className="text-xs text-gray-500 mt-0.5">{client.industry}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {hasRole('admin') && (
                        <button
                          type="button"
                          onClick={async e => {
                            e.stopPropagation();
                            setDeletingClient(client);
                            setDeleteConfirmOpen(true);
                          }}
                          className="p-1.5 rounded-lg border border-gray-200 text-gray-400 hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors"
                          title="Delete client"
                        >
                          <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M3 6h18" />
                            <path d="M8 6V4h8v2" />
                            <path d="M6 6l1 16h10l1-16" />
                          </svg>
                        </button>
                      )}
                      <ArrowRight className="w-4 h-4 text-gray-300 group-hover:text-brand-primary transition-colors" />
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <Globe className="w-3.5 h-3.5" />
                      <span className="truncate">{client.website_url || '—'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-gray-500">
                      <Calendar className="w-3.5 h-3.5" />
                      <span>{new Date(client.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>

                  <div className="mt-4 pt-3 border-t border-gray-50 flex items-center justify-between gap-2">
                    <span className="text-xs text-gray-400 shrink-0">
                      {clientAudits.length} audit{clientAudits.length !== 1 ? 's' : ''}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      {lastAudit && (
                        <span className="text-xs text-gray-400">
                          Last: {new Date(lastAudit.updated_at).toLocaleDateString()}
                        </span>
                      )}
                      {client.hubspot_company_id && (
                        <HoverTooltip label="Auto-synced from the ECD CRM" align="end">
                          <span
                            className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 cursor-default"
                            onClick={e => e.stopPropagation()}
                          >
                            <RefreshCw className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                            Auto-synced
                          </span>
                        </HoverTooltip>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {!loading && filtered.length > PAGE_SIZE && (
          <div className="mt-6 flex items-center justify-between">
            <p className="text-xs text-gray-400">
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length} clients
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Previous
              </button>
              <span className="text-xs font-medium text-gray-500 px-2">
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-200 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                Next
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
