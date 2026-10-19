import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Users,
  Key,
  Trash2,
  UserPlus,
  Image as ImageIcon,
  Plus,
  Pencil,
  TrendingUp,
  GripVertical,
  ArrowUp,
  ArrowDown,
  ChevronDown,
  RefreshCw,
  Check,
  ShieldCheck,
} from 'lucide-react';
import TopBar from '../components/layout/TopBar';
import Modal from '../components/ui/Modal';
import ImageUploadZone from '../components/ui/ImageUploadZone';
import { useAuth } from '../contexts/AuthContext';
import HoverTooltip from '../components/ui/HoverTooltip';
import { ALL_AREAS, AREA_LABELS, canManageUsers } from '../lib/access';
import type { AppAccess, AppArea } from '../lib/types';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../components/ui/select';
import { supabase } from '../lib/supabase';
import { DEFAULT_HOURLY_RATE, getWebAuditHourlyRate, updateWebAuditHourlyRate } from '../lib/web-audit-pricing';
import SimpleRichEditor from '../components/ui/SimpleRichEditor';
import {
  listRevenueOpportunityTemplates,
  createRevenueOpportunityTemplate,
  updateRevenueOpportunityTemplate,
  deleteRevenueOpportunityTemplate,
  uploadRevenueOpportunityImage,
} from '../lib/db';
import type { CatalogAuditType, RevenueOpportunityTemplate } from '../lib/types';
import XeroSettingsPanel from '../components/proposal/XeroSettingsPanel';
import { listXeroServiceAccounts, type XeroServiceAccount } from '../lib/xero';
import XeroItemPicker, { useXeroItems } from '../components/proposal/XeroItemPicker';

const TABS = [
  { id: 'users', label: 'Users', icon: Users },
  { id: 'revenue_opportunities', label: 'Line Item Catalog', icon: TrendingUp },
  { id: 'settings', label: 'API Connection', icon: Key },
];

/** Radix Select reserves the empty string, so "unset" needs its own token. */
const NO_XERO_SERVICE = '__none__';

/** Flip to true to show the Audit Templates & Export Options placeholder cards in Settings again. */
const SHOW_ADMIN_SETTINGS_PLACEHOLDERS = false;

type AdminUserRow = {
  id: string;
  email: string | null;
  name: string | null;
  role: 'admin' | 'auditor' | 'viewer';
  app_access?: AppAccess | null;
  created_at?: string | null;
};

export default function AdminArea() {
  // Tab lives in the URL so external redirects can land on it (the Xero OAuth
  // callback returns to ?tab=settings), and so a refresh keeps your place.
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  // Settings is open to every staff account: the Line Item Catalog and API
  // Connection are shared tools. Only user management stays admin-only, so the
  // Users tab simply is not there for members.
  const isAdmin = canManageUsers(user);
  const visibleTabs = isAdmin ? TABS : TABS.filter(t => t.id !== 'users');
  const tabParam = searchParams.get('tab') ?? '';
  const tab = visibleTabs.some(t => t.id === tabParam) ? tabParam : visibleTabs[0].id;
  const setTab = (next: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  return (
    <div>
      <TopBar title="Settings" subtitle={isAdmin ? 'Manage users and platform settings' : 'Platform settings'} />

      <div className="p-8 animate-fade-in">
        <div className="flex gap-2 mb-6 border-b border-gray-100 pb-3">
          {visibleTabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'bg-brand-primary/10 text-brand-primary'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              <t.icon className="w-4 h-4" />
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'users' && isAdmin && <UsersTab />}
        {tab === 'revenue_opportunities' && <RevenueOpportunitiesTab />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </div>
  );
}

function UsersTab() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);
  const [savingRoleFor, setSavingRoleFor] = useState<string | null>(null);
  const [removingFor, setRemovingFor] = useState<string | null>(null);
  const [removeConfirmUser, setRemoveConfirmUser] = useState<AdminUserRow | null>(null);
  const [editingNameFor, setEditingNameFor] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [savingNameFor, setSavingNameFor] = useState<string | null>(null);

  const currentUserId = currentUser?.id || '';

  const sorted = useMemo(() => {
    const copy = [...users];
    copy.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
    return copy;
  }, [users]);

  const reload = async () => {
    setError('');
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, email, name, role, app_access, created_at')
        .order('created_at', { ascending: true });
      if (error) throw error;
      setUsers((data ?? []) as AdminUserRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Show current user immediately to avoid a "blank loading" feel.
    if (currentUser?.id) {
      setUsers(prev => {
        if (prev.some(u => u.id === currentUser.id)) return prev;
        return [
          {
            id: currentUser.id,
            email: currentUser.email ?? null,
            name: currentUser.name ?? null,
            role: (currentUser.role as any) ?? 'viewer',
            created_at: null,
          },
          ...prev,
        ];
      });
    }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flip one area checkbox for a member. Admins have everything by definition,
  // so their boxes render checked and disabled rather than being editable state
  // that silently means nothing.
  const onToggleAccess = async (row: AdminUserRow, area: AppArea) => {
    setError('');
    const current: AppAccess = { audits: true, proposals: true, documents: true, ...(row.app_access ?? {}) };
    const next: AppAccess = { ...current, [area]: !(current[area] !== false) };
    const prev = users;
    setUsers(u => u.map(x => (x.id === row.id ? { ...x, app_access: next } : x)));
    try {
      setSavingRoleFor(row.id);
      const { data, error } = await supabase.functions.invoke('admin_users', {
        body: { action: 'update_access', user_id: row.id, app_access: next },
      });
      if (error) throw error;
      if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Failed to save access');
    } catch (e) {
      setUsers(prev);
      setError(e instanceof Error ? e.message : 'Failed to save access');
    } finally {
      setSavingRoleFor(null);
    }
  };

  const onInvite = async () => {
    setError('');
    try {
      setInviting(true);
      const email = inviteEmail.trim();
      const { data, error } = await supabase.functions.invoke('admin_users', {
        body: { action: 'invite', email },
      });
      if (error) throw error;
      if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Invite failed');
      setInviteEmail('');
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invite failed');
    } finally {
      setInviting(false);
    }
  };

  const onChangeRole = async (userId: string, role: AdminUserRow['role']) => {
    setError('');
    const prev = users;
    setUsers(u => u.map(x => x.id === userId ? { ...x, role } : x));
    try {
      setSavingRoleFor(userId);
      const { data, error } = await supabase.functions.invoke('admin_users', {
        body: { action: 'update_role', user_id: userId, role },
      });
      if (error) throw error;
      if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Failed to save role');
    } catch (e) {
      setUsers(prev);
      setError(e instanceof Error ? e.message : 'Failed to save role');
    } finally {
      setSavingRoleFor(null);
    }
  };

  const onSaveName = async (userId: string) => {
    const name = nameDraft.trim();
    if (!name) {
      setError('Name cannot be empty.');
      return;
    }
    setError('');
    const prev = users;
    setUsers(u => u.map(x => x.id === userId ? { ...x, name } : x));
    try {
      setSavingNameFor(userId);
      const { data, error } = await supabase.functions.invoke('admin_users', {
        body: { action: 'update_name', user_id: userId, name },
      });
      if (error) throw error;
      if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Failed to save name');
      setEditingNameFor(null);
    } catch (e) {
      setUsers(prev);
      setError(e instanceof Error ? e.message : 'Failed to save name');
    } finally {
      setSavingNameFor(null);
    }
  };

  const confirmRemove = async () => {
    if (!removeConfirmUser) return;
    const userId = removeConfirmUser.id;
    setError('');
    try {
      setRemovingFor(userId);
      const { data, error } = await supabase.functions.invoke('admin_users', {
        body: { action: 'remove', user_id: userId },
      });
      if (error) throw error;
      if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Failed to remove user');
      setRemoveConfirmUser(null);
      setUsers(u => u.filter(x => x.id !== userId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove user');
    } finally {
      setRemovingFor(null);
    }
  };

  return (
    <div className="bg-white rounded-xl card-shadow animate-slide-up">
      <Modal
        open={!!removeConfirmUser}
        title="Remove user?"
        onClose={() => { if (!removingFor) setRemoveConfirmUser(null); }}
        className="max-w-lg"
      >
        <div className="p-5">
          <p className="text-sm text-gray-700">
            {removeConfirmUser
              ? <>Remove <span className="font-semibold">{removeConfirmUser.name || removeConfirmUser.email}</span>? They will lose access to the platform. This cannot be undone.</>
              : 'Remove this user? This cannot be undone.'}
          </p>
          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={!!removingFor}
              onClick={() => setRemoveConfirmUser(null)}
              className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!!removingFor}
              onClick={confirmRemove}
              className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {removingFor ? 'Removing…' : 'Remove user'}
            </button>
          </div>
        </div>
      </Modal>

      <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-900">Team Members</h2>
        <div className="flex items-center gap-2">
          <div className="hidden sm:block">
            <input
              type="email"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="name@example.com"
              className="w-[260px] px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
            />
          </div>
          <button
            onClick={onInvite}
            disabled={inviting || !inviteEmail.trim()}
            className="px-4 py-2 gradient-bg text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            <UserPlus className="w-4 h-4" />
            {inviting ? 'Inviting...' : 'Invite User'}
        </button>
        </div>
      </div>

      {error && (
        <div className="px-6 pt-4">
          <div className="text-sm text-red-600 bg-red-50 px-4 py-2.5 rounded-lg">{error}</div>
        </div>
      )}

      <div className="divide-y divide-gray-50">
        {loading && sorted.length === 0 ? (
          <div className="px-6 py-8 text-sm text-gray-400">Loading users…</div>
        ) : (
          sorted.map(user => (
          <div key={user.id} className="flex items-center justify-between px-6 py-4 gap-4">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full gradient-bg flex items-center justify-center text-white text-xs font-bold">
                {(user.name || user.email || 'U')
                  .split(' ')
                  .filter(Boolean)
                  .slice(0, 2)
                  .map(n => n[0])
                  .join('')
                  .toUpperCase()}
              </div>
              <div className="min-w-0">
                {editingNameFor === user.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      autoFocus
                      value={nameDraft}
                      onChange={e => setNameDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') onSaveName(user.id);
                        if (e.key === 'Escape') setEditingNameFor(null);
                      }}
                      className="w-40 rounded-lg border border-gray-200 px-2 py-1 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
                    />
                    <button
                      type="button"
                      onClick={() => onSaveName(user.id)}
                      disabled={savingNameFor === user.id}
                      className="text-xs font-medium text-brand-primary hover:underline disabled:opacity-50"
                    >
                      {savingNameFor === user.id ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingNameFor(null)}
                      disabled={savingNameFor === user.id}
                      className="text-xs text-gray-500 hover:text-gray-700"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => { setNameDraft(user.name || ''); setEditingNameFor(user.id); }}
                    className="text-sm font-medium text-gray-900 hover:underline text-left"
                  >
                    {user.name || 'Add name'}
                  </button>
                )}
                <p className="text-xs text-gray-500">{user.email || '—'}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* On the LEFT of the controls, so appearing and disappearing
                  never shifts the checkboxes and buttons mid-click. */}
              {savingRoleFor === user.id && (
                <span className="text-xs text-gray-400">Saving...</span>
              )}
              {/* Which of the three areas this person can use. Everyone always
                  has Clients, the Dashboard, the Line Item Catalog and API
                  Connection, so those need no boxes. Admin boxes are shown
                  checked and locked: admin means everything. */}
              <HoverTooltip
                align="end"
                label={user.role === 'admin' ? 'Full access' : 'Areas'}
                description={
                  user.role === 'admin'
                    ? 'Admins always have access to every area, so these cannot be unchecked.'
                    : 'The areas this member can use. Clients, the Dashboard, the Line Item Catalog and API Connection are always available to everyone.'
                }
              >
              <div className="hidden md:flex items-center gap-1.5">
                {ALL_AREAS.map(area => {
                  const isAdminRow = user.role === 'admin';
                  const checked = isAdminRow || (user.app_access?.[area] !== false);
                  return (
                    <button
                      key={area}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      disabled={isAdminRow || savingRoleFor === user.id}
                      onClick={() => onToggleAccess(user, area)}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                        checked
                          ? 'border-brand-primary/40 bg-brand-primary/5 text-brand-primary'
                          : 'border-gray-200 text-gray-400 hover:bg-gray-50'
                      } ${isAdminRow ? 'opacity-60 cursor-default' : ''}`}
                    >
                      <span
                        className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${
                          checked ? 'border-brand-primary bg-brand-primary text-white' : 'border-gray-300 bg-white'
                        }`}
                      >
                        {checked && <Check className="h-2.5 w-2.5" />}
                      </span>
                      {AREA_LABELS[area]}
                    </button>
                  );
                })}
              </div>
              </HoverTooltip>
              {/* Admin is a toggle, not a dropdown: with "admin means everything"
                  there are only two states, member-with-checkboxes or admin. The
                  old Viewer role is gone from the UI (nobody has it; it was the
                  pre-roles read-only value). You cannot un-admin yourself, so
                  there is always an admin left who can manage users. */}
              <HoverTooltip
                align="end"
                label="Admin"
                description={
                  user.id === currentUserId
                    ? 'Admins can invite, remove and manage users, and have full access to every area. You cannot change your own admin role, so there is always an admin left.'
                    : 'Admins can invite, remove and manage users on this page, and have full access to every area. Turn it off to make this person a Member who works only in the checked areas.'
                }
              >
                <button
                  type="button"
                  role="switch"
                  aria-checked={user.role === 'admin'}
                  disabled={savingRoleFor === user.id || user.id === currentUserId}
                  onClick={() => onChangeRole(user.id, user.role === 'admin' ? 'auditor' : 'admin')}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
                    user.role === 'admin'
                      ? 'border-brand-primary bg-brand-primary text-white'
                      : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                  } ${user.id === currentUserId ? 'opacity-60 cursor-default' : ''}`}
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Admin
                </button>
              </HoverTooltip>
              <HoverTooltip
                align="end"
                label={user.id === currentUserId ? "You can't remove yourself" : 'Remove user'}
              >
                <button
                  onClick={() => {
                    if (user.id === currentUserId) {
                      setError("You can't remove your own account.");
                      return;
                    }
                    setRemoveConfirmUser(user);
                  }}
                  disabled={removingFor === user.id || user.id === currentUserId}
                  className="h-9 w-9 inline-flex items-center justify-center rounded-lg border border-gray-200 text-gray-400 hover:text-red-600 hover:border-red-200 hover:bg-red-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </HoverTooltip>
            </div>
          </div>
          ))
        )}
      </div>
    </div>
  );
}

const AUDIT_TYPE_META: Record<CatalogAuditType, { label: string; cls: string }> = {
  both: { label: 'Both', cls: 'bg-purple-50 text-purple-700' },
  klaviyo: { label: 'Klaviyo', cls: 'bg-blue-50 text-blue-700' },
  web: { label: 'Website', cls: 'bg-amber-50 text-amber-700' },
};

/** Two branded checkboxes (Klaviyo / Website) that map to the audit_type value.
 * Both checked = 'both'; keeps at least one checked. Avoids a confusing "Both"
 * option in a plain dropdown. */
function AppliesToChecks({ value, onChange }: { value: CatalogAuditType; onChange: (v: CatalogAuditType) => void }) {
  const klaviyo = value === 'klaviyo' || value === 'both';
  const web = value === 'web' || value === 'both';
  const set = (nextK: boolean, nextW: boolean) => {
    if (!nextK && !nextW) return; // always keep at least one channel
    onChange(nextK && nextW ? 'both' : nextK ? 'klaviyo' : 'web');
  };
  const Box = ({ checked, label, onToggle }: { checked: boolean; label: string; onToggle: () => void }) => (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
        checked ? 'border-brand-primary bg-brand-primary/5 text-brand-primary' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
      }`}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors ${
          checked ? 'border-brand-primary bg-brand-primary text-white' : 'border-gray-300 bg-white'
        }`}
      >
        {checked && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap gap-2">
      <Box checked={klaviyo} label="Klaviyo audits" onToggle={() => set(!klaviyo, web)} />
      <Box checked={web} label="Website audits" onToggle={() => set(klaviyo, !web)} />
    </div>
  );
}

/** Assigns a catalog service to a Xero revenue bucket. Uses the shared branded
 * Select, and degrades to a clear hint when no buckets exist yet. */
/**
 * Every catalog service must be mapped to Xero before it is saved (Zak, Oct
 * 2026): its revenue family, and the Xero Item for each price it carries. A
 * service sold as both a project and a retainer needs both Items.
 */
function xeroMappingProblem(entry: {
  xero_service_key?: string | null;
  xero_item_one_time?: string | null;
  xero_item_monthly?: string | null;
  one_time_price?: number | null;
  monthly_price?: number | null;
}): string | null {
  if (!entry.xero_service_key) return 'Pick its Xero revenue account (Retention, Website or Paid ads).';
  const oneTime = Number(entry.one_time_price ?? 0) > 0;
  const monthly = Number(entry.monthly_price ?? 0) > 0;
  if (oneTime && !entry.xero_item_one_time) return 'Pick the Xero Item for the one-time price.';
  if (monthly && !entry.xero_item_monthly) return 'Pick the Xero Item for the monthly price.';
  if (!entry.xero_item_one_time && !entry.xero_item_monthly) return 'Pick the Xero Item it is invoiced as.';
  return null;
}

function XeroServicePicker({
  value,
  services,
  onChange,
}: {
  value: string;
  services: XeroServiceAccount[];
  onChange: (key: string) => void;
}) {
  if (services.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
        No revenue accounts yet. Add them under <span className="font-medium">API Connection &gt; Xero</span> first.
      </p>
    );
  }
  return (
    <Select value={value || NO_XERO_SERVICE} onValueChange={v => onChange(v === NO_XERO_SERVICE ? '' : v)}>
      <SelectTrigger className="h-10 text-sm">
        <SelectValue placeholder="Choose a revenue account" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_XERO_SERVICE}>
          <SelectItemText>Not set</SelectItemText>
        </SelectItem>
        {services.map(sv => (
          <SelectItem key={sv.service_key} value={sv.service_key}>
            <SelectItemText>
              {sv.name}
              {sv.one_time_account_code ? ` · one-time ${sv.one_time_account_code}` : ''}
            </SelectItemText>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function RevenueOpportunitiesTab() {
  const [entries, setEntries] = useState<RevenueOpportunityTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [reorderingId, setReorderingId] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [uploadingImageId, setUploadingImageId] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // The Xero revenue buckets, so each service can be assigned one here rather
  // than on every proposal line.
  const [xeroServices, setXeroServices] = useState<XeroServiceAccount[]>([]);
  const { items: xeroItems, error: xeroItemsError } = useXeroItems();

  useEffect(() => {
    let cancelled = false;
    listXeroServiceAccounts()
      .then(rows => { if (!cancelled) setXeroServices(rows); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const toggleExpanded = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleEntryImageUpload = async (entryId: string, file: File | undefined) => {
    if (!file) return;
    setError('');
    setUploadingImageId(entryId);
    try {
      const url = await uploadRevenueOpportunityImage(file);
      setEntries(prev => prev.map(p => (p.id === entryId ? { ...p, image_url: url } : p)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Image upload failed');
    } finally {
      setUploadingImageId(null);
    }
  };

  const [filterType, setFilterType] = useState<'all' | 'web' | 'klaviyo'>('all');
  const [newEntry, setNewEntry] = useState({
    name: '',
    description: '',
    content: '',
    auditType: 'both' as CatalogAuditType,
    oneTimePrice: '',
    oneTimeLabel: '',
    monthlyPrice: '',
    monthlyLabel: '',
    isActive: true,
    xeroServiceKey: '',
    xeroItemOneTime: null as string | null,
    xeroItemMonthly: null as string | null,
  });
  const toHandle = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  const uniqueHandleFromName = (name: string, rows: RevenueOpportunityTemplate[], currentId?: string) => {
    const base = toHandle(name) || 'template';
    const used = new Set(
      rows
        .filter(row => row.id !== currentId)
        .map(row => row.slug),
    );
    if (!used.has(base)) return base;
    let i = 2;
    while (used.has(`${base}_${i}`)) i += 1;
    return `${base}_${i}`;
  };

  const reload = useCallback(async () => {
    setError('');
    try {
      setLoading(true);
      const data = await listRevenueOpportunityTemplates();
      setEntries(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => a.display_order - b.display_order),
    [entries],
  );

  const saveEntry = async (entry: RevenueOpportunityTemplate) => {
    setError('');
    const problem = xeroMappingProblem(entry);
    if (problem) {
      setError(`${entry.name || 'This service'}: ${problem}`);
      return;
    }
    setSavingId(entry.id);
    try {
      await updateRevenueOpportunityTemplate(entry.id, {
        slug: uniqueHandleFromName(entry.name, entries, entry.id),
        name: entry.name.trim(),
        description: entry.description.trim(),
        audit_type: entry.audit_type,
        content: entry.content.trim(),
        one_time_price: entry.one_time_price ?? null,
        one_time_label: entry.one_time_label?.trim() || null,
        monthly_price: entry.monthly_price ?? null,
        monthly_label: entry.monthly_label?.trim() || null,
        default_revenue_monthly: 0,
        image_url: entry.image_url ?? null,
        details_url: entry.details_url?.trim() || null,
        xero_service_key: entry.xero_service_key || null,
        xero_item_one_time: entry.xero_item_one_time || null,
        xero_item_monthly: entry.xero_item_monthly || null,
        display_order: Number(entry.display_order || 0),
        is_active: Boolean(entry.is_active),
      });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save template');
    } finally {
      setSavingId(null);
    }
  };

  const removeEntry = async (id: string) => {
    setError('');
    setDeletingId(id);
    try {
      await deleteRevenueOpportunityTemplate(id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete template');
    } finally {
      setDeletingId(null);
    }
  };

  const createEntry = async () => {
    setError('');
    const name = newEntry.name.trim();
    if (!name) {
      setError('Name is required');
      return;
    }
    const problem = xeroMappingProblem({
      xero_service_key: newEntry.xeroServiceKey,
      xero_item_one_time: newEntry.xeroItemOneTime,
      xero_item_monthly: newEntry.xeroItemMonthly,
      one_time_price: newEntry.oneTimePrice ? Number(newEntry.oneTimePrice) : null,
      monthly_price: newEntry.monthlyPrice ? Number(newEntry.monthlyPrice) : null,
    });
    if (problem) {
      setError(problem);
      return;
    }
    setCreating(true);
    try {
      const nextDisplayOrder = entries.reduce((max, e) => Math.max(max, e.display_order || 0), 0) + 10;
      const created = await createRevenueOpportunityTemplate({
        slug: uniqueHandleFromName(name, entries),
        name,
        description: newEntry.description.trim(),
        audit_type: newEntry.auditType,
        content: newEntry.content.trim(),
        bullets: [],
        default_revenue_monthly: 0,
        one_time_price: newEntry.oneTimePrice ? Number(newEntry.oneTimePrice) : null,
        one_time_label: newEntry.oneTimeLabel.trim() || null,
        monthly_price: newEntry.monthlyPrice ? Number(newEntry.monthlyPrice) : null,
        monthly_label: newEntry.monthlyLabel.trim() || null,
        display_order: nextDisplayOrder,
        is_active: newEntry.isActive,
        xero_service_key: newEntry.xeroServiceKey || null,
        xero_item_one_time: newEntry.xeroItemOneTime,
        xero_item_monthly: newEntry.xeroItemMonthly,
      });
      setNewEntry({
        name: '',
        description: '',
        content: '',
        auditType: 'both',
        oneTimePrice: '',
        oneTimeLabel: '',
        monthlyPrice: '',
        monthlyLabel: '',
        isActive: true,
        xeroServiceKey: '',
        xeroItemOneTime: null,
        xeroItemMonthly: null,
      });
      setShowCreateModal(false);
      setExpandedIds(prev => new Set(prev).add(created.id));
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create template');
    } finally {
      setCreating(false);
    }
  };

  const moveEntry = async (entryId: string, direction: 'up' | 'down') => {
    const local = [...sortedEntries];
    const idx = local.findIndex(e => e.id === entryId);
    if (idx < 0) return;
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= local.length) return;

    [local[idx], local[target]] = [local[target], local[idx]];
    const reindexed = local.map((entry, i) => ({ ...entry, display_order: (i + 1) * 10 }));
    const previousById = new Map(sortedEntries.map(e => [e.id, e.display_order]));
    const changed = reindexed.filter(e => previousById.get(e.id) !== e.display_order);

    setEntries(reindexed);
    setReorderingId(entryId);
    try {
      await Promise.all(
        changed.map(entry =>
          updateRevenueOpportunityTemplate(entry.id, { display_order: entry.display_order }),
        ),
      );
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reorder templates');
      setEntries(sortedEntries);
    } finally {
      setReorderingId(null);
    }
  };

  const reorderEntries = async (nextSortedEntries: RevenueOpportunityTemplate[], actionId?: string) => {
    const reindexed = nextSortedEntries.map((entry, i) => ({ ...entry, display_order: (i + 1) * 10 }));
    const previousById = new Map(sortedEntries.map(e => [e.id, e.display_order]));
    const changed = reindexed.filter(e => previousById.get(e.id) !== e.display_order);
    if (changed.length === 0) return;

    setEntries(reindexed);
    setReorderingId(actionId ?? null);
    try {
      await Promise.all(
        changed.map(entry =>
          updateRevenueOpportunityTemplate(entry.id, { display_order: entry.display_order }),
        ),
      );
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reorder templates');
      setEntries(sortedEntries);
    } finally {
      setReorderingId(null);
    }
  };

  return (
    <div className="space-y-6 animate-slide-up">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Line Item Catalog</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            Manage reusable services and pricing that can be selected in the audit wizard and on proposals.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5" role="tablist" aria-label="Filter by audit type">
            {([['all', 'All'], ['klaviyo', 'Klaviyo'], ['web', 'Website']] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                role="tab"
                aria-selected={filterType === val}
                onClick={() => setFilterType(val)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  filterType === val ? 'gradient-bg text-white shadow-sm' : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowCreateModal(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 gradient-bg text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
          >
            <Plus className="w-4 h-4" />
            New template
          </button>
        </div>
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 px-4 py-2.5 rounded-lg">{error}</div>}

      <Modal open={showCreateModal} title="Create New Template" onClose={() => setShowCreateModal(false)}>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Name</label>
            <input
              type="text"
              value={newEntry.name}
              onChange={e => setNewEntry(prev => ({ ...prev, name: e.target.value }))}
              placeholder="Klaviyo SMS"
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Description</label>
            <input
              type="text"
              value={newEntry.description}
              onChange={e => setNewEntry(prev => ({ ...prev, description: e.target.value }))}
              placeholder="One-line summary shown in the report card."
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1.5">Applies to</label>
            <AppliesToChecks value={newEntry.auditType} onChange={(v) => setNewEntry(prev => ({ ...prev, auditType: v }))} />
            <p className="text-xs text-gray-400 mt-1.5">Which audit types this service shows up in. Pick one or both.</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Body</label>
            <SimpleRichEditor
              value={newEntry.content}
              onChange={(value) => setNewEntry(prev => ({ ...prev, content: value }))}
              rows={4}
              placeholder="Paragraphs or bullet lists — use the list button in the toolbar."
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">One-time price ($)</label>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={newEntry.oneTimePrice}
                onChange={e => setNewEntry(prev => ({ ...prev, oneTimePrice: e.target.value.replace(/[^0-9.]/g, '') }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">One-time price note</label>
              <input
                type="text"
                value={newEntry.oneTimeLabel}
                onChange={e => setNewEntry(prev => ({ ...prev, oneTimeLabel: e.target.value }))}
                placeholder="e.g. Full $2,500 · Mini $500"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Monthly retainer ($)</label>
              <input
                type="text"
                inputMode="decimal"
                placeholder="0"
                value={newEntry.monthlyPrice}
                onChange={e => setNewEntry(prev => ({ ...prev, monthlyPrice: e.target.value.replace(/[^0-9.]/g, '') }))}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Monthly price note</label>
              <input
                type="text"
                value={newEntry.monthlyLabel}
                onChange={e => setNewEntry(prev => ({ ...prev, monthlyLabel: e.target.value }))}
                placeholder="e.g. $12,000+/mo"
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
              />
            </div>
            {/* Mapped to Xero before it exists (Zak, Oct 2026), so it can never reach an invoice uncoded. */}
            <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-3 gap-3 rounded-lg border border-gray-100 bg-gray-50/60 p-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Xero revenue account</label>
                <XeroServicePicker
                  value={newEntry.xeroServiceKey}
                  services={xeroServices}
                  onChange={key => setNewEntry(prev => ({ ...prev, xeroServiceKey: key }))}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Xero Item, one-time</label>
                <XeroItemPicker
                  value={newEntry.xeroItemOneTime}
                  items={xeroItems}
                  invalid={Number(newEntry.oneTimePrice || 0) > 0 && !newEntry.xeroItemOneTime}
                  onChange={code => setNewEntry(prev => ({ ...prev, xeroItemOneTime: code }))}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Xero Item, monthly</label>
                <XeroItemPicker
                  value={newEntry.xeroItemMonthly}
                  items={xeroItems}
                  invalid={Number(newEntry.monthlyPrice || 0) > 0 && !newEntry.xeroItemMonthly}
                  onChange={code => setNewEntry(prev => ({ ...prev, xeroItemMonthly: code }))}
                />
              </div>
              <p className="md:col-span-3 text-[11px] text-gray-400">
                Required: the account family, and an Item for each price this service has.
                {xeroItemsError ? ` Xero Items could not be loaded (${xeroItemsError}).` : ''}
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 mt-2 cursor-pointer select-none md:col-span-2">
              <button
                type="button"
                role="switch"
                aria-checked={newEntry.isActive}
                onClick={() => setNewEntry(prev => ({ ...prev, isActive: !prev.isActive }))}
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${newEntry.isActive ? 'bg-brand-primary' : 'bg-gray-200'}`}
              >
                <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform ${newEntry.isActive ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
              Active in wizard
            </label>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-gray-100 pt-4">
            <button
              type="button"
              onClick={() => setShowCreateModal(false)}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={createEntry}
              disabled={creating}
              className="px-4 py-2 gradient-bg text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create Template'}
            </button>
          </div>
        </div>
      </Modal>

      <div className="space-y-3">
        {loading ? (
          <div className="bg-white rounded-xl p-6 card-shadow text-sm text-gray-500">Loading templates...</div>
        ) : entries.length === 0 ? (
          <div className="bg-white rounded-xl p-8 card-shadow text-center text-sm text-gray-500">
            No templates yet. Use <span className="font-medium text-gray-700">New template</span> above to create one.
          </div>
        ) : (
          sortedEntries.map((entry, index) => {
            // Klaviyo filter shows klaviyo + both; Website shows web + both.
            if (filterType !== 'all' && entry.audit_type !== 'both' && entry.audit_type !== filterType) return null;
            const expanded = expandedIds.has(entry.id);
            const priceParts: string[] = [];
            if (entry.one_time_price) priceParts.push(`$${Number(entry.one_time_price).toLocaleString()} one-time`);
            if (entry.monthly_price) priceParts.push(`$${Number(entry.monthly_price).toLocaleString()}/mo`);

            return (
              <div
                key={entry.id}
                onDragOver={e => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex === null || dragIndex === index) return;
                  const next = sortedEntries.slice();
                  const [moved] = next.splice(dragIndex, 1);
                  next.splice(index, 0, moved);
                  setDragIndex(null);
                  reorderEntries(next, entry.id);
                }}
                className={`bg-white rounded-xl card-shadow transition-colors overflow-hidden ${dragIndex === index ? 'ring-2 ring-brand-primary/30 bg-brand-primary/[0.02]' : ''}`}
              >
                <div className="flex items-center gap-3 px-4 py-3">
                  <div
                    draggable
                    onDragStart={(e) => {
                      setDragIndex(index);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setDragIndex(null)}
                    className="shrink-0 text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing"
                    title="Drag to reorder"
                  >
                    <GripVertical className="w-4 h-4" />
                  </div>

                  {entry.image_url ? (
                    <img
                      src={entry.image_url}
                      alt=""
                      className="h-11 w-11 shrink-0 rounded-lg border border-gray-200 object-cover"
                    />
                  ) : (
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-dashed border-gray-200 bg-gray-50 text-gray-300">
                      <ImageIcon className="h-4 w-4" />
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={() => toggleExpanded(entry.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-gray-900 truncate">{entry.name || 'Untitled template'}</p>
                      <span className={`shrink-0 inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ${AUDIT_TYPE_META[entry.audit_type].cls}`}>
                        {AUDIT_TYPE_META[entry.audit_type].label}
                      </span>
                      <span className={`shrink-0 inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ${entry.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                        {entry.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 truncate mt-0.5">
                      {entry.description || 'No description yet'}
                      {priceParts.length ? <span className="text-gray-400"> · {priceParts.join(' · ')}</span> : null}
                    </p>
                  </button>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => moveEntry(entry.id, 'up')}
                      disabled={index === 0 || reorderingId === entry.id}
                      className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-gray-200 text-gray-500 hover:text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      title="Move up"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveEntry(entry.id, 'down')}
                      disabled={index === sortedEntries.length - 1 || reorderingId === entry.id}
                      className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-gray-200 text-gray-500 hover:text-gray-700 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                      title="Move down"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleExpanded(entry.id)}
                      className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-gray-200 text-gray-500 hover:text-gray-700 hover:bg-gray-50"
                      title={expanded ? 'Collapse' : 'Edit'}
                    >
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                    </button>
                  </div>
                </div>

                {expanded && (
                  <div className="border-t border-gray-100 px-5 py-4 space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Name</label>
                      <input
                        type="text"
                        value={entry.name}
                        onChange={e => setEntries(prev => prev.map(p => (p.id === entry.id ? { ...p, name: e.target.value } : p)))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1.5">Applies to</label>
                      <AppliesToChecks
                        value={entry.audit_type}
                        onChange={(v) => setEntries(prev => prev.map(p => (p.id === entry.id ? { ...p, audit_type: v } : p)))}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Description</label>
                      <input
                        type="text"
                        value={entry.description}
                        onChange={e => setEntries(prev => prev.map(p => (p.id === entry.id ? { ...p, description: e.target.value } : p)))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Body</label>
                      <SimpleRichEditor
                        value={entry.content}
                        onChange={(value) => {
                          setEntries(prev => prev.map(p => (
                            p.id === entry.id ? { ...p, content: value } : p
                          )));
                        }}
                        rows={4}
                        placeholder="Paragraphs or bullet lists — use the list button in the toolbar."
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Default screenshot</label>
                      <ImageUploadZone
                        compact
                        className="max-w-md"
                        previewUrl={entry.image_url}
                        previewAlt={`${entry.name} screenshot`}
                        label={entry.image_url ? 'Replace image' : 'Add screenshot'}
                        hint="Click, then paste with Ctrl+V, or drag & drop"
                        replaceLabel="Replace image"
                        uploading={uploadingImageId === entry.id}
                        onFile={file => handleEntryImageUpload(entry.id, file)}
                        onRemove={entry.image_url ? () => setEntries(prev => prev.map(p => (p.id === entry.id ? { ...p, image_url: null } : p))) : undefined}
                      />
                      <p className="mt-1.5 text-[11px] text-gray-400">Shown by default on the report add-on card.</p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Details doc URL</label>
                      <input
                        type="url"
                        placeholder="https://…"
                        value={entry.details_url ?? ''}
                        onChange={e => setEntries(prev => prev.map(p => (
                          p.id === entry.id ? { ...p, details_url: e.target.value || null } : p
                        )))}
                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
                      />
                      <p className="mt-1 text-[11px] text-gray-400">Powers the &quot;View more details&quot; button on the report card (opens in a new tab).</p>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Xero revenue account</label>
                      <XeroServicePicker
                        value={entry.xero_service_key ?? ''}
                        services={xeroServices}
                        onChange={key => setEntries(prev => prev.map(pp => (
                          pp.id === entry.id ? { ...pp, xero_service_key: key || null } : pp
                        )))}
                      />
                      <p className="mt-1 text-[11px] text-gray-400">
                        Proposal lines added from this service are coded here automatically. One-time money posts to the
                        family's one-time account (4011/4012/4013), anything on an ongoing invoice to its MRR account
                        (4002/4001/4003).
                      </p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Xero Item, one-time</label>
                        <XeroItemPicker
                          value={entry.xero_item_one_time}
                          items={xeroItems}
                          invalid={Number(entry.one_time_price ?? 0) > 0 && !entry.xero_item_one_time}
                          onChange={code => setEntries(prev => prev.map(pp => (
                            pp.id === entry.id ? { ...pp, xero_item_one_time: code } : pp
                          )))}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Xero Item, monthly</label>
                        <XeroItemPicker
                          value={entry.xero_item_monthly}
                          items={xeroItems}
                          invalid={Number(entry.monthly_price ?? 0) > 0 && !entry.xero_item_monthly}
                          onChange={code => setEntries(prev => prev.map(pp => (
                            pp.id === entry.id ? { ...pp, xero_item_monthly: code } : pp
                          )))}
                        />
                      </div>
                      <p className="md:col-span-2 -mt-1 text-[11px] text-gray-400">
                        Required for each price this service has. Saving is blocked until it is mapped.
                        {xeroItemsError ? ` Xero Items could not be loaded (${xeroItemsError}).` : ''}
                      </p>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">One-time price ($)</label>
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="0"
                          value={entry.one_time_price ? String(entry.one_time_price) : ''}
                          onChange={e => {
                            const raw = e.target.value.replace(/[^0-9.]/g, '');
                            setEntries(prev => prev.map(p => (
                              p.id === entry.id ? { ...p, one_time_price: raw === '' ? null : Number(raw) } : p
                            )));
                          }}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">One-time price note</label>
                        <input
                          type="text"
                          value={entry.one_time_label ?? ''}
                          onChange={e => setEntries(prev => prev.map(p => (
                            p.id === entry.id ? { ...p, one_time_label: e.target.value || null } : p
                          )))}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Monthly retainer ($)</label>
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="0"
                          value={entry.monthly_price ? String(entry.monthly_price) : ''}
                          onChange={e => {
                            const raw = e.target.value.replace(/[^0-9.]/g, '');
                            setEntries(prev => prev.map(p => (
                              p.id === entry.id ? { ...p, monthly_price: raw === '' ? null : Number(raw) } : p
                            )));
                          }}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-500 mb-1">Monthly price note</label>
                        <input
                          type="text"
                          value={entry.monthly_label ?? ''}
                          onChange={e => setEntries(prev => prev.map(p => (
                            p.id === entry.id ? { ...p, monthly_label: e.target.value || null } : p
                          )))}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
                        />
                      </div>
                      <label className="flex items-center gap-2 text-sm text-gray-700 mt-2 cursor-pointer select-none md:col-span-2">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={entry.is_active}
                          onClick={() => setEntries(prev => prev.map(p => (
                            p.id === entry.id ? { ...p, is_active: !p.is_active } : p
                          )))}
                          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors ${entry.is_active ? 'bg-brand-primary' : 'bg-gray-200'}`}
                        >
                          <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm ring-0 transition-transform ${entry.is_active ? 'translate-x-4' : 'translate-x-0'}`} />
                        </button>
                        Active in wizard
                      </label>
                    </div>

                    <div className="flex items-center gap-2 border-t border-gray-50 pt-4">
                      <button
                        type="button"
                        onClick={() => saveEntry(entry)}
                        disabled={savingId === entry.id}
                        className="px-4 py-2 text-sm font-medium rounded-lg bg-brand-primary text-white hover:bg-brand-primary-dark disabled:opacity-50"
                      >
                        {savingId === entry.id ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (window.confirm(`Delete "${entry.name || 'this template'}"? This can't be undone.`)) {
                            removeEntry(entry.id);
                          }
                        }}
                        disabled={deletingId === entry.id}
                        className="px-4 py-2 text-sm font-medium rounded-lg border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        {deletingId === entry.id ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/** The rate a web audit's roadmap hours are priced at. Only new roadmaps read
 *  this: each one stamps the rate it was built with, so changing it here never
 *  reprices a report a client has already read. */
function WebAuditRateCard() {
  const [rate, setRate] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const value = await getWebAuditHourlyRate();
        if (!cancelled) setRate(String(value));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const onSave = async () => {
    const n = Number(rate);
    if (!Number.isFinite(n) || n <= 0) {
      setError('Enter an hourly rate above zero.');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await updateWebAuditHourlyRate(n);
      setSuccess('Saved. New web audit roadmaps will price setup at this rate.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the rate');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-6">
      <h3 className="text-base font-semibold text-gray-900">Web Audit Hourly Rate</h3>
      <p className="mt-1 text-sm text-gray-500">
        Setup cost on a web audit roadmap is the hours you estimate times this rate. Clients see the money, never the hours.
      </p>
      <div className="mt-4">
        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="web-audit-rate">Rate per hour</label>
        <div className="flex items-center gap-2">
          <span className="text-gray-400">$</span>
          <input
            id="web-audit-rate"
            type="number"
            min={1}
            step={5}
            disabled={loading}
            placeholder={String(DEFAULT_HOURLY_RATE)}
            className="w-32 px-3 py-2.5 border border-gray-200 rounded-lg text-sm tabular-nums focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20 disabled:opacity-50"
            value={rate}
            onChange={e => { setRate(e.target.value); setSuccess(''); }}
          />
        </div>
        <p className="text-xs text-gray-400 mt-1">
          Each roadmap stamps the rate it was generated with, so raising this never reprices an audit already sent. Override a
          single audit from its roadmap section.
        </p>
      </div>
      {error && <div className="mt-3 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</div>}
      {success && <div className="mt-3 text-sm text-emerald-700 bg-emerald-50 px-3 py-2 rounded-lg">{success}</div>}
      <div className="mt-4">
        <button
          type="button"
          onClick={onSave}
          disabled={saving || loading}
          className="px-4 py-2 gradient-bg text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function ApiKeyCard({
  provider,
  title,
  description,
  placeholder,
  savedMessage,
}: {
  provider: 'openai' | 'anthropic' | 'hubspot' | 'fireflies' | 'gemini';
  title: string;
  description: string;
  placeholder: string;
  savedMessage: string;
}) {
  const [status, setStatus] = useState<{ configured: boolean; updated_at: string | null } | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [apiKey, setApiKey] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setStatusLoading(true);
        // Supabase client attaches the session JWT automatically — skip extra getSession() round trip.
        const { data, error } = await supabase.functions.invoke('openai_key_admin', {
          body: { action: 'status', provider },
        });
        if (cancelled) return;
        if (error) throw error;
        if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Failed to load key status');
        setStatus({ configured: Boolean(data.configured), updated_at: data.updated_at ?? null });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load status');
      } finally {
        if (!cancelled) setStatusLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [provider]);

  const onSave = async () => {
    setError('');
    setSuccess('');
    try {
      setSaving(true);
      const { data, error } = await supabase.functions.invoke('openai_key_admin', {
        body: { action: 'set', provider, api_key: apiKey },
      });
      if (error) throw error;
      if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Failed to save key');
      setApiKey('');
      setEditing(false);
      setSuccess(savedMessage);
      const st = await supabase.functions.invoke('openai_key_admin', { body: { action: 'status', provider } });
      if (!st.error && st.data?.ok === true) {
        setStatus({ configured: Boolean(st.data.configured), updated_at: st.data.updated_at ?? null });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save key');
    } finally {
      setSaving(false);
    }
  };

  return (
      <div className="bg-white rounded-xl p-6 card-shadow">
        <div className="flex items-center gap-2 mb-4">
          <Key className="w-4 h-4 text-gray-400" />
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          {description}
        </p>
        {statusLoading ? (
          <div className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-4" aria-busy="true">
            <div className="h-4 bg-gray-200/80 rounded w-[40%] mb-2.5 animate-pulse" />
            <div className="h-3 bg-gray-100 rounded w-[65%] animate-pulse" />
          </div>
        ) : status?.configured && !editing ? (
          <>
            <div className="flex items-center gap-3 rounded-lg border border-emerald-100 bg-emerald-50 px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-emerald-800">API key is configured</p>
                <p className="text-xs text-emerald-600 mt-0.5">
                  {status.updated_at ? `Last updated ${new Date(status.updated_at).toLocaleString()}` : 'Stored encrypted and used server-side only.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => { setEditing(true); setSuccess(''); setError(''); }}
                className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg shadow-sm hover:bg-gray-50 hover:border-gray-300 transition-colors"
              >
                <Pencil className="w-3.5 h-3.5 text-gray-500" />
                Edit Key
              </button>
            </div>
            {error && <div className="mt-3 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</div>}
            {success && <div className="mt-3 text-sm text-emerald-700 bg-emerald-50 px-3 py-2 rounded-lg">{success}</div>}
          </>
        ) : (
          <>
            {status && !status.configured && (
              <div className="mb-4 text-xs text-gray-500">Status: Not configured</div>
            )}
        <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {status?.configured ? 'New API Key' : 'API Key'}
              </label>
          <input
            type="password"
            placeholder={placeholder}
            className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm font-mono focus:outline-none focus:border-brand-primary focus:ring-1 focus:ring-brand-primary/20"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                autoFocus={editing}
          />
          <p className="text-xs text-gray-400 mt-1">
                Stored encrypted in Supabase and used server-side only.
          </p>
        </div>
            {error && <div className="mt-3 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</div>}
            {success && <div className="mt-3 text-sm text-emerald-700 bg-emerald-50 px-3 py-2 rounded-lg">{success}</div>}
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={onSave}
                disabled={saving || !apiKey.trim()}
                className="px-4 py-2 gradient-bg text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              {editing && (
                <button
                  type="button"
                  onClick={() => { setEditing(false); setApiKey(''); setError(''); }}
                  className="px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-700 transition-colors"
                >
                  Cancel
                </button>
              )}
            </div>
          </>
        )}
      </div>
  );
}

type HubSpotSyncState = {
  last_synced_at: string | null;
  backfill_cursor: string | null;
  last_result: {
    ok?: boolean;
    mode?: string;
    scanned?: number;
    created?: number;
    linked?: number;
    skipped?: number;
    backfill_remaining?: boolean;
    at?: string;
    error?: { code?: string; message?: string };
  } | null;
};

function HubSpotSyncCard() {
  const [state, setState] = useState<HubSpotSyncState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');

  const loadState = useCallback(async () => {
    const { data } = await supabase
      .from('hubspot_sync_state')
      .select('last_synced_at, backfill_cursor, last_result')
      .eq('id', 'default')
      .maybeSingle();
    setState((data as HubSpotSyncState) ?? null);
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const syncNow = async () => {
    setSyncing(true);
    setError('');
    try {
      const { data, error: fnError } = await supabase.functions.invoke('hubspot_sync', { body: {} });
      if (fnError) throw fnError;
      if (data?.ok !== true) throw new Error(data?.error?.message ?? 'Sync failed');
      await loadState();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
      await loadState().catch(() => {});
    } finally {
      setSyncing(false);
    }
  };

  const result = state?.last_result;
  return (
    <div className="bg-white rounded-xl p-6 card-shadow">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <RefreshCw className="w-4 h-4 text-gray-400" />
          <h3 className="text-base font-semibold text-gray-900">HubSpot Sync</h3>
        </div>
        <button
          type="button"
          onClick={syncNow}
          disabled={syncing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      <p className="text-sm text-gray-500 mb-4">
        New HubSpot companies are pulled in automatically every 15 minutes and created as clients
        (with their primary contact's name and email). Companies matching an existing client by
        name or website are linked instead of duplicated.
      </p>
      <div className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3 text-xs text-gray-600 space-y-1">
        <p>
          <span className="text-gray-400">Last synced:</span>{' '}
          {state?.last_synced_at ? new Date(state.last_synced_at).toLocaleString() : 'Never (first sync runs a backfill)'}
        </p>
        {result?.ok === true && (
          <p>
            <span className="text-gray-400">Last run:</span>{' '}
            {result.created ?? 0} created · {result.linked ?? 0} linked · {result.skipped ?? 0} already synced
            {result.backfill_remaining ? ' · backfill still in progress, run Sync now again' : ''}
          </p>
        )}
        {result?.ok === false && (
          <p className="text-red-600">Last run failed: {result.error?.message ?? 'Unknown error'}</p>
        )}
      </div>
      {error && <div className="mt-3 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</div>}
    </div>
  );
}

function SettingsTab() {
  return (
    // Two columns from lg up: the cards are short and independent, so a single
    // narrow column made this page much longer to scan than it needed to be.
    // The cards are direct grid children rather than two column stacks, so they
    // fill left to right across each row; stacks would read top-down per column
    // and leave the left side short. items-start stops a tall card stretching
    // its neighbour.
    <div className="animate-slide-up grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        {/* Full width and first: the revenue-account mapping is a four-column
            table, so it needs the room the short API-key cards do not. */}
        <div className="lg:col-span-2">
          <XeroSettingsPanel />
        </div>

        <WebAuditRateCard />

        <ApiKeyCard
          provider="openai"
          title="OpenAI Integration"
          description="Configure your OpenAI API key to enable AI-powered audit analysis. This key is stored securely and used only for generating audit findings."
          placeholder="sk-..."
          savedMessage="Saved. Edge Functions will use this key for AI analysis."
        />

        <ApiKeyCard
          provider="anthropic"
          title="Anthropic (Claude) Integration"
          description="Configure your Anthropic API key to power the AI proposal assistant. Create one at console.anthropic.com. This key is stored securely and used server-side only."
          placeholder="sk-ant-..."
          savedMessage="Saved. The proposal assistant will use this key."
        />

        <ApiKeyCard
          provider="gemini"
          title="Google Gemini (Image) Integration"
          description="Configure a Google Gemini API key to generate 'after' concept images on web audits (the AI edits the real screenshot to show the recommended fixes). Create one at aistudio.google.com, Get API key. Stored securely and used server-side only."
          placeholder="Gemini API key"
          savedMessage="Saved. Web audits will use this key to generate 'after' concept images."
        />

        <ApiKeyCard
          provider="hubspot"
          title="HubSpot Integration"
          description="Connect HubSpot with a Private App access token to auto-create clients from new HubSpot companies. In HubSpot: Settings, Integrations, Private Apps, create an app with the crm.objects.companies.read and crm.objects.contacts.read scopes, then paste the token here."
          placeholder="pat-..."
          savedMessage="Saved. Run Sync now below to import your HubSpot companies."
        />

        <ApiKeyCard
          provider="fireflies"
          title="Fireflies Integration"
          description="Add a Fireflies API key so the proposal assistant can read meeting transcripts from a Fireflies link. In Fireflies: Settings, Developer, copy your API key, then paste it here. Stored securely and used server-side only."
          placeholder="Fireflies API key"
          savedMessage="Saved. Paste a Fireflies link into the proposal assistant and it will read the transcript."
        />

        <HubSpotSyncCard />

      {SHOW_ADMIN_SETTINGS_PLACEHOLDERS && (
        <>
      <div className="bg-white rounded-xl p-6 card-shadow">
        <h3 className="text-base font-semibold text-gray-900 mb-4">Audit Templates</h3>
        <p className="text-sm text-gray-500 mb-3">
          Manage audit section templates and default content. Templates define the structure of each audit report.
        </p>
        <div className="bg-gray-50 rounded-lg p-4 text-center">
          <p className="text-sm text-gray-400">Template management coming in a future release.</p>
        </div>
      </div>

      <div className="bg-white rounded-xl p-6 card-shadow">
        <h3 className="text-base font-semibold text-gray-900 mb-4">Export Options</h3>
        <p className="text-sm text-gray-500 mb-3">
          Future integrations for exporting audit reports to external formats.
        </p>
        <div className="bg-gray-50 rounded-lg p-4 text-center">
          {/* Future: Google Slides export integration */}
          <p className="text-sm text-gray-400">Google Slides and PDF export coming soon.</p>
        </div>
      </div>
        </>
      )}
    </div>
  );
}
