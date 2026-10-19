import { useMemo, useState } from 'react';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/select';
import { useToast } from '../ui/Toast';
import { updateRevenueOpportunityTemplate } from '../../lib/db';
import type { RevenueOpportunityTemplate } from '../../lib/types';
import type { XeroServiceAccount } from '../../lib/xero';

/** Radix Select reserves the empty string, so "unset" needs its own token. */
const UNSET = '__unset__';

/**
 * Every line item in the catalog, with the Xero account its money actually posts
 * to, editable here.
 *
 * This exists because the bucket rows above are an abstraction: they hold the
 * account codes, but on their own they never showed WHICH services feed them, so
 * the mapping was invisible from this screen. Assigning a line item is possible
 * here and in the Line Item Catalog; both write the same field.
 */
export default function XeroLineItemMapping({
  templates,
  services,
  mrrAccountCode,
  onChanged,
}: {
  templates: RevenueOpportunityTemplate[];
  services: XeroServiceAccount[];
  mrrAccountCode: string | null;
  onChanged: (slug: string, serviceKey: string | null) => void;
}) {
  const toast = useToast();
  const [savingSlug, setSavingSlug] = useState<string | null>(null);
  const byKey = useMemo(() => new Map(services.map(s => [s.service_key, s])), [services]);

  const save = async (t: RevenueOpportunityTemplate, next: string | null) => {
    setSavingSlug(t.slug);
    try {
      await updateRevenueOpportunityTemplate(t.id, { xero_service_key: next });
      onChanged(t.slug, next);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save that mapping');
    } finally {
      setSavingSlug(null);
    }
  };

  /** What the invoice will actually use, mirroring resolveAccountCode server-side. */
  const resolved = (t: RevenueOpportunityTemplate) => {
    const row = t.xero_service_key ? byKey.get(t.xero_service_key) : undefined;
    const oneTime = (row?.one_time_account_code ?? '').trim();
    const monthly = (row?.monthly_account_code ?? '').trim() || (mrrAccountCode ?? '').trim();
    return {
      oneTime: oneTime || null,
      monthly: monthly || null,
      oneTimeItem: t.xero_item_one_time ?? null,
      monthlyItem: t.xero_item_monthly ?? null,
      // Only prices that exist on the template can ever be invoiced.
      hasOneTime: Number(t.one_time_price ?? 0) > 0 || Boolean(t.one_time_label),
      hasMonthly: Number(t.monthly_price ?? 0) > 0 || Boolean(t.monthly_label),
    };
  };

  const unmapped = templates.filter(t => {
    const r = resolved(t);
    return (r.hasOneTime && (!r.oneTime || !r.oneTimeItem)) || (r.hasMonthly && (!r.monthly || !r.monthlyItem));
  }).length;

  if (templates.length === 0) return null;

  return (
    <div className="mt-4 rounded-lg border border-gray-100 bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Line items and where they post</h4>
          <p className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-gray-400">
            Every service in your catalog, the Xero account it will hit and the Item it is invoiced as. Set the Items
            in the Line Item Catalog. A proposal line created from a service inherits both.
          </p>
        </div>
        {unmapped > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5" />
            {unmapped} need an account or Item
          </span>
        )}
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="hidden gap-3 px-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400 sm:grid sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto]">
          <span>Line item</span>
          <span>Revenue bucket</span>
          <span className="text-right">Posts to</span>
        </div>

        {templates.map(t => {
          const r = resolved(t);
          const missing = (r.hasOneTime && (!r.oneTime || !r.oneTimeItem)) || (r.hasMonthly && (!r.monthly || !r.monthlyItem));
          return (
            <div
              key={t.slug}
              className={`grid items-center gap-3 rounded-lg px-1 py-1.5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] ${
                missing ? 'bg-amber-50/60' : ''
              }`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-gray-900" title={t.name}>{t.name}</p>
                <p className="text-[10px] text-gray-400">
                  {[r.hasOneTime ? 'one-time' : null, r.hasMonthly ? 'monthly' : null].filter(Boolean).join(' + ') ||
                    'no pricing'}
                </p>
              </div>

              <div className="flex items-center gap-1.5">
                <Select
                  value={t.xero_service_key || UNSET}
                  onValueChange={v => void save(t, v === UNSET ? null : v)}
                  disabled={savingSlug === t.slug || services.length === 0}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder={services.length ? 'Choose' : 'Add a bucket first'} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNSET}><SelectItemText>Not set</SelectItemText></SelectItem>
                    {services.map(sv => (
                      <SelectItem key={sv.service_key} value={sv.service_key}>
                        <SelectItemText>{sv.name}</SelectItemText>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {savingSlug === t.slug && <Loader2 className="h-3.5 w-3.5 animate-spin text-gray-400" />}
              </div>

              <div className="flex flex-wrap items-center justify-end gap-1 text-right">
                {r.hasOneTime && (
                  <AccountChip label="one-time" code={r.oneTime} item={r.oneTimeItem} />
                )}
                {r.hasMonthly && (
                  <AccountChip label="monthly" code={r.monthly} item={r.monthlyItem} />
                )}
                {!r.hasOneTime && !r.hasMonthly && (
                  <span className="text-[10px] text-gray-300">not invoiced</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AccountChip({ label, code, item }: { label: string; code: string | null; item: string | null }) {
  if (!code || !item) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
        <AlertTriangle className="h-3 w-3" />
        {label}: {code ? `${code}, no Item` : 'none'}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
      <Check className="h-3 w-3" />
      {label}: {code} · Item {item}
    </span>
  );
}
