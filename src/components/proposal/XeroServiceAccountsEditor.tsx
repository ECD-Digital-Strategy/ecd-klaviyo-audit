import { useEffect, useState } from 'react';
import { Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/select';
import { useToast } from '../ui/Toast';
import { listRevenueOpportunityTemplates } from '../../lib/db';
import XeroLineItemMapping from './XeroLineItemMapping';
import type { RevenueOpportunityTemplate } from '../../lib/types';
import {
  deleteXeroServiceAccount,
  listXeroServiceAccounts,
  saveXeroServiceAccounts,
  type XeroAccount,
  type XeroServiceAccount,
} from '../../lib/xero';

/** A Xero account code: a dropdown of real accounts when we have them, and a
 * plain code box when we do not, so the mapping can be filled in before the
 * Xero connection exists. */
function AccountPicker({
  value,
  accounts,
  placeholder,
  onChange,
  disabled,
}: {
  value: string;
  accounts: XeroAccount[];
  placeholder: string;
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  if (accounts.length === 0) {
    return (
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="e.g. 4011"
        disabled={disabled}
        className="h-9 w-full rounded-lg border border-gray-200 px-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/20 disabled:opacity-50"
      />
    );
  }
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="h-9 text-sm"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {accounts.map(a => (
          <SelectItem key={a.code} value={a.code}>
            <SelectItemText>{a.code} - {a.name}</SelectItemText>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const slugify = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/**
 * Maps each service family to the revenue accounts its money posts to.
 *
 * One-time work posts to that service's own sales account. Recurring posts to
 * the shared MRR account, unless a service needs its own, which is what the
 * second column is for.
 */
export default function XeroServiceAccountsEditor({
  accounts,
  mrrAccountCode,
}: {
  accounts: XeroAccount[];
  /** Shown as the resolved monthly account for buckets without an override. */
  mrrAccountCode: string | null;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<XeroServiceAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [catalog, setCatalog] = useState<RevenueOpportunityTemplate[]>([]);

  useEffect(() => {
    listXeroServiceAccounts()
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
    // Best effort: the row still works without the catalog, it just cannot show
    // which services feed the bucket.
    listRevenueOpportunityTemplates().then(setCatalog).catch(() => {});
  }, []);


  const patch = (index: number, next: Partial<XeroServiceAccount>) => {
    setRows(prev => prev.map((r, i) => (i === index ? { ...r, ...next } : r)));
    setDirty(true);
  };

  const addRow = () => {
    setRows(prev => [
      ...prev,
      {
        service_key: '',
        name: '',
        one_time_account_code: '',
        monthly_account_code: '',
        display_order: (prev.length + 1) * 10,
      },
    ]);
    setDirty(true);
  };

  const removeRow = async (index: number) => {
    const row = rows[index];
    // A saved row has to go from the database too, or it reappears on reload.
    if (row.service_key) {
      if (!window.confirm(`Remove ${row.name || row.service_key}? Proposal lines already using it will block invoicing until they are re-categorised.`)) return;
      try {
        await deleteXeroServiceAccount(row.service_key);
      } catch (e) {
        toast(e instanceof Error ? e.message : 'Could not remove that service');
        return;
      }
    }
    setRows(prev => prev.filter((_, i) => i !== index));
  };

  const save = async () => {
    const cleaned = rows
      .map((r, i) => ({
        ...r,
        name: r.name.trim(),
        // Derive the stable key from the name on first save, then leave it alone
        // so proposal lines already pointing at it keep resolving.
        service_key: r.service_key || slugify(r.name),
        display_order: (i + 1) * 10,
      }))
      .filter(r => r.name && r.service_key);
    if (cleaned.length === 0) {
      toast('Give each service a name first');
      return;
    }
    setSaving(true);
    try {
      await saveXeroServiceAccounts(cleaned);
      setRows(await listXeroServiceAccounts());
      setDirty(false);
      toast('Revenue accounts saved');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the mapping');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="h-24 animate-pulse rounded-lg bg-gray-50" />;

  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Revenue accounts by service</h4>
          {/* Say plainly where the link to real services is made, because this
              screen only holds the buckets and their codes. */}
          <p className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-gray-400">
            Each family has two accounts: one-time work posts to the one-time account (4011/4012/4013), anything on
            an ongoing invoice to the MRR account (4002/4001/4003). Assign your line items to a family and a Xero Item
            in the table below, and a proposal line created from that service is coded automatically.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={addRow}
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50"
          >
            <Plus className="h-3.5 w-3.5" /> Add service
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-1 rounded-lg gradient-bg px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="mt-3 text-[11px] text-gray-400">
          No services yet. Add one per revenue account, for example Klaviyo with one-time 4011.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="hidden gap-2 px-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 sm:grid sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
            <span>Bucket name</span>
            <span>One-time account</span>
            <span>Monthly account</span>
            <span />
          </div>
          {rows.map((row, i) => (
            <div key={row.service_key || `new-${i}`} className="grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
              <div className="min-w-0">
                <input
                  value={row.name}
                  onChange={e => patch(i, { name: e.target.value })}
                  placeholder="Klaviyo"
                  className="h-9 w-full rounded-lg border border-gray-200 px-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                />
              </div>
              <AccountPicker
                value={row.one_time_account_code ?? ''}
                accounts={accounts}
                placeholder="One-time"
                onChange={code => patch(i, { one_time_account_code: code })}
              />
              <AccountPicker
                value={row.monthly_account_code ?? ''}
                accounts={accounts}
                placeholder="Choose the MRR account"
                onChange={code => patch(i, { monthly_account_code: code })}
              />
              <button
                type="button"
                onClick={() => void removeRow(i)}
                title="Remove service"
                className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-400 hover:bg-red-50 hover:text-red-600"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <XeroLineItemMapping
        templates={catalog}
        services={rows.filter(r => r.service_key)}
        mrrAccountCode={mrrAccountCode}
        onChanged={(slug, key) =>
          setCatalog(prev => prev.map(t => (t.slug === slug ? { ...t, xero_service_key: key } : t)))
        }
      />
    </div>
  );
}
