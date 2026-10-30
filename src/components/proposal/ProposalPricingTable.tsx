import { useEffect, useState, type ReactNode } from 'react';
import { Receipt, ArrowUp, ArrowDown, Trash2, Plus, ChevronDown, BadgePercent, X, Play } from 'lucide-react';
import { cn } from '../../lib/utils';
import { addOnHasCustomerAgentDemo, nameHasCustomerAgentDemo, customerAgentDemoUrlOrDefault } from '../../lib/customer-agent-demo';
import DemoPopupModal, { type DemoPopupState } from '../ui/DemoPopupModal';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/select';
import { MenuPriceRow, SummaryTotalRow } from './PriceRows';
import ProposalPlainText from './edit/ProposalPlainText';
import ProposalCurrency from './edit/ProposalCurrency';
import { useProposalEdit } from './edit/ProposalEditContext';
import { useProposalOptions } from './ProposalOptions';
import {
  buildProposalPriceLines,
  computeProposalTotals,
  formatProposalTotal,
  lineItemHasPricing,
  lineIsTaken,
  proposalDiscountFromRow,
} from '../../lib/proposal-pricing';
import { formatCurrency } from '../../lib/revenue-calculator';
import { listRevenueOpportunityTemplates } from '../../lib/db';
import { listXeroServiceAccounts, type XeroServiceAccount } from '../../lib/xero';
import XeroItemPicker, { useXeroItems } from './XeroItemPicker';
import type {
  Proposal,
  ProposalLineItem,
  ProposalTemplateLineItem,
  RevenueOpportunityTemplate,
} from '../../lib/types';

function catalogToTemplateItem(t: RevenueOpportunityTemplate): ProposalTemplateLineItem {
  return {
    template_slug: t.slug,
    name: t.name,
    description: t.description,
    content: t.content ?? '',
    one_time_price: t.one_time_price ?? null,
    one_time_label: t.one_time_label ?? null,
    monthly_price: t.monthly_price ?? null,
    monthly_label: t.monthly_label ?? null,
    image_url: t.image_url ?? null,
    // Carry the catalog's Xero bucket onto the line, so a line added from the
    // catalog is already coded and only freehand lines need a manual pick.
    xero_service_key: t.xero_service_key ?? null,
    xero_item_one_time: t.xero_item_one_time ?? null,
    xero_item_monthly: t.xero_item_monthly ?? null,
    display_order: 0,
  };
}

/** Which revenue account this line's money lands in. Only shown when the line
 * actually has a price, and only when service mapping has been configured, so it
 * stays out of the way for anyone not using Xero. */
function LineItemRevenueCategory({
  item,
  onChange,
}: {
  item: ProposalLineItem;
  onChange: (patch: Partial<Pick<ProposalLineItem, 'xero_service_key' | 'xero_item_one_time' | 'xero_item_monthly'>>) => void;
}) {
  const [services, setServices] = useState<XeroServiceAccount[] | null>(null);
  const { items } = useXeroItems();

  useEffect(() => {
    let cancelled = false;
    listXeroServiceAccounts()
      .then(rows => { if (!cancelled) setServices(rows); })
      .catch(() => { if (!cancelled) setServices([]); });
    return () => { cancelled = true; };
  }, []);

  if (!services || services.length === 0 || !lineItemHasPricing(item)) return null;
  const current = item.xero_service_key ?? '';
  const needsOneTime = Number(item.one_time_price ?? 0) > 0;
  const needsMonthly = Number(item.monthly_price ?? 0) > 0;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3 print:hidden">
      <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Revenue account</span>
      <div className="w-52">
        <Select value={current} onValueChange={key => onChange({ xero_service_key: key })}>
          <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Choose a service" /></SelectTrigger>
          <SelectContent>
            {services.map(sv => (
              <SelectItem key={sv.service_key} value={sv.service_key}>
                <SelectItemText>{sv.name}</SelectItemText>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {/* The Item is optional on a freehand line (the family alone codes the
          account); lines from the catalog arrive with it already set. */}
      {needsOneTime && (
        <div className="w-56">
          <XeroItemPicker size="sm" value={item.xero_item_one_time} items={items} placeholder="Xero Item, one-time" onChange={code => onChange({ xero_item_one_time: code })} />
        </div>
      )}
      {needsMonthly && (
        <div className="w-56">
          <XeroItemPicker size="sm" value={item.xero_item_monthly} items={items} placeholder="Xero Item, monthly" onChange={code => onChange({ xero_item_monthly: code })} />
        </div>
      )}
      {!current && (
        <span className="text-[11px] text-amber-600">Needed before a Xero invoice can be created</span>
      )}
    </div>
  );
}

function EditableLineItemRow({
  item,
  isFirst,
  isLast,
}: {
  item: ProposalLineItem;
  isFirst: boolean;
  isLast: boolean;
}) {
  const { updateLineItem, removeLineItem, moveLineItem } = useProposalEdit();

  return (
    <div className="group/item relative rounded-xl border border-gray-100 bg-gray-50/40 px-4 py-3.5">
      <div className="absolute -right-2 -top-2 z-10 flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-1 py-1 opacity-0 shadow-sm transition-opacity group-hover/item:opacity-100 focus-within:opacity-100 print:hidden">
        <button
          type="button"
          onClick={() => moveLineItem(item.id, -1)}
          disabled={isFirst}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-50 hover:text-gray-600 disabled:opacity-30"
          title="Move up"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => moveLineItem(item.id, 1)}
          disabled={isLast}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-gray-50 hover:text-gray-600 disabled:opacity-30"
          title="Move down"
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => removeLineItem(item.id)}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-gray-400 hover:bg-red-50 hover:text-red-600"
          title="Remove line item"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <ProposalPlainText
        value={item.name}
        onSave={value => updateLineItem(item.id, { name: value })}
        as="p"
        placeholder="Line item name"
        className="text-base font-semibold text-gray-900"
      />
      <ProposalPlainText
        value={item.description}
        onSave={value => updateLineItem(item.id, { description: value })}
        as="p"
        placeholder="Short description shown under the name (optional)"
        className="mt-1 text-sm leading-relaxed text-gray-500"
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">One-time</span>
          <ProposalCurrency
            value={item.one_time_price}
            onSave={value => updateLineItem(item.id, { one_time_price: value })}
            ariaLabel={`${item.name} one-time price`}
            className="text-sm font-semibold text-gray-900"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Monthly</span>
          <ProposalCurrency
            value={item.monthly_price}
            onSave={value => updateLineItem(item.id, { monthly_price: value })}
            ariaLabel={`${item.name} monthly price`}
            className="text-sm font-semibold text-gray-900"
          />
        </div>
        {!lineItemHasPricing(item) && (
          <span className="text-[11px] text-amber-600">No pricing (hidden from the pricing table)</span>
        )}
      </div>

      <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-xs text-gray-600 print:hidden">
        <input
          type="checkbox"
          checked={Boolean(item.optional)}
          onChange={e => updateLineItem(item.id, { optional: e.target.checked })}
          className="h-3.5 w-3.5 rounded border-gray-300 accent-[#4b3afe]"
        />
        Optional: the client chooses whether to add it when signing
      </label>

      <LineItemRevenueCategory item={item} onChange={patch => updateLineItem(item.id, patch)} />
    </div>
  );
}

function DiscountEditor({ proposal }: { proposal: Proposal }) {
  const { updateDiscount } = useProposalEdit();
  const hasDiscount = proposal.discount_type !== 'none' && proposal.discount_value > 0;
  const [open, setOpen] = useState(hasDiscount);

  useEffect(() => {
    if (hasDiscount) setOpen(true);
  }, [hasDiscount]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          updateDiscount({ discount_type: 'fixed' });
        }}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-primary hover:underline print:hidden"
      >
        <BadgePercent className="h-3.5 w-3.5" />
        Add discount
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-100 bg-emerald-50/50 px-3 py-2 print:hidden">
      <input
        type="text"
        value={proposal.discount_label ?? ''}
        onChange={e => updateDiscount({ discount_label: e.target.value || null })}
        placeholder="Discount label (e.g. Founding client discount)"
        className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
      />
      <div className="flex overflow-hidden rounded-md border border-gray-200 bg-white">
        {(['fixed', 'percent'] as const).map(kind => (
          <button
            key={kind}
            type="button"
            onClick={() => updateDiscount({ discount_type: kind })}
            className={cn(
              'px-2.5 py-1.5 text-xs font-semibold transition-colors',
              proposal.discount_type === kind
                ? 'bg-brand-primary text-white'
                : 'text-gray-500 hover:bg-gray-50',
            )}
          >
            {kind === 'fixed' ? '$' : '%'}
          </button>
        ))}
      </div>
      <input
        type="text"
        inputMode="decimal"
        value={proposal.discount_value ? String(proposal.discount_value) : ''}
        onChange={e => {
          const raw = e.target.value.replace(/[^0-9.]/g, '');
          updateDiscount({ discount_value: raw ? Number(raw) : 0 });
        }}
        placeholder="0"
        aria-label="Discount value"
        className="w-20 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-right text-xs tabular-nums focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
      />
      <Select
        value={proposal.discount_applies_to}
        onValueChange={value =>
          updateDiscount({ discount_applies_to: value as Proposal['discount_applies_to'] })
        }
      >
        <SelectTrigger className="h-8 w-[7.5rem] text-xs" aria-label="Discount applies to">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one_time"><SelectItemText>One-time</SelectItemText></SelectItem>
          <SelectItem value="monthly"><SelectItemText>Monthly</SelectItemText></SelectItem>
          <SelectItem value="both"><SelectItemText>Both</SelectItemText></SelectItem>
        </SelectContent>
      </Select>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          updateDiscount({ discount_type: 'none', discount_value: 0, discount_label: null });
        }}
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-white hover:text-red-600"
        title="Remove discount"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

type ProposalPricingTableProps = {
  proposal: Proposal;
  lineItems: ProposalLineItem[];
  clientWebsite?: string | null;
};

export default function ProposalPricingTable({ proposal, lineItems, clientWebsite }: ProposalPricingTableProps) {
  const { editMode, addLineItem } = useProposalEdit();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [catalog, setCatalog] = useState<RevenueOpportunityTemplate[] | null>(null);
  const [demoPopup, setDemoPopup] = useState<DemoPopupState | null>(null);
  // Live Customer Agent / Customer Hub demo, keyed to the client's storefront when
  // known, otherwise the generic demo.
  const demoUrl = customerAgentDemoUrlOrDefault(clientWebsite ?? proposal.client?.website_url ?? null);
  const itemHasDemo = (item: ProposalLineItem) =>
    (item.template_slug ? addOnHasCustomerAgentDemo(item.template_slug) : false) || nameHasCustomerAgentDemo(item.name);

  const { picked, canChoose, toggle } = useProposalOptions();
  const sorted = [...lineItems].sort((a, b) => a.display_order - b.display_order);
  const pricedItems = sorted.filter(lineItemHasPricing);
  const regularItems = pricedItems.filter(item => !item.optional);
  const optionalItems = pricedItems.filter(item => item.optional);
  const undecided = optionalItems.some(item => item.client_selected == null);
  const priceLines = buildProposalPriceLines(sorted);
  const discount = proposalDiscountFromRow(proposal);
  const totals = computeProposalTotals(sorted, discount, picked);

  // One priced line item: its price rows (one-time and/or monthly), description and demo.
  const renderPricedItem = (item: ProposalLineItem, name: ReactNode) => {
    const lines = priceLines.filter(line => line.lineItemId === item.id);
    return (
      <>
        {lines.map((line, lineIndex) => (
          <MenuPriceRow
            key={`${line.lineItemId}-${line.unit}`}
            label={
              lineIndex === 0
                ? name
                : line.unit === 'monthly'
                  ? 'Monthly retainer'
                  : 'One-time implementation'
            }
            amount={line.headline}
            caption={line.caption}
            labelClassName={lineIndex > 0 ? 'pl-3 text-sm font-normal text-gray-600' : undefined}
          />
        ))}
        {item.description ? (
          <p className="-mt-1 pb-2.5 pr-[30%] text-xs leading-relaxed text-gray-500">
            {item.description}
          </p>
        ) : null}
        {itemHasDemo(item) ? (
          <div className="pb-3 print:hidden">
            <button
              type="button"
              onClick={() => setDemoPopup({ url: demoUrl, title: item.name })}
              className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
            >
              <Play className="h-3.5 w-3.5 shrink-0 fill-current" aria-hidden /> View demo
            </button>
            <p className="mt-1.5 pr-[15%] text-[11px] leading-relaxed text-gray-400">
              This is a live demo on your own store to show what is possible. The final build depends on which Klaviyo Customer Agent add-ons you decide to go with.
            </p>
          </div>
        ) : null}
      </>
    );
  };

  // An optional line's name: a tick box while the client can still choose, else what was decided.
  const optionalName = (item: ProposalLineItem) => {
    const decided = item.client_selected != null;
    if (canChoose && !decided) {
      return (
        <label className="inline-flex cursor-pointer items-start gap-2.5">
          <input
            type="checkbox"
            checked={lineIsTaken(item, picked)}
            onChange={() => toggle(item.id)}
            className="mt-[0.3rem] h-4 w-4 shrink-0 cursor-pointer rounded border-gray-300 accent-[#4b3afe] print:hidden"
            aria-label={`Add ${item.name}`}
          />
          <span>{item.name}</span>
        </label>
      );
    }
    const badge = !decided
      ? { text: 'Optional', className: 'bg-gray-100 text-gray-600' }
      : item.client_selected
        ? { text: 'Added', className: 'bg-emerald-50 text-emerald-700' }
        : { text: 'Not included', className: 'bg-gray-100 text-gray-500' };
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={cn(decided && !item.client_selected && 'text-gray-400 line-through decoration-gray-300')}>{item.name}</span>
        <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', badge.className)}>{badge.text}</span>
      </span>
    );
  };

  useEffect(() => {
    if (!catalogOpen || catalog !== null) return;
    listRevenueOpportunityTemplates({ activeOnly: true })
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, [catalogOpen, catalog]);

  const showOneTime = totals.oneTimeSubtotal > 0 || totals.oneTimeHasLabelOnly;
  const showMonthly = totals.monthlySubtotal > 0 || totals.monthlyHasLabelOnly;
  const discountLabel = proposal.discount_label?.trim() || 'Discount';

  return (
    <section className="proposal-section overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm">
      <div className="flex items-start gap-3 border-b border-gray-200 bg-gray-50 px-6 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-primary/10 ring-1 ring-brand-primary/15">
          <Receipt className="h-5 w-5 text-brand-primary" strokeWidth={2.25} />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-gray-900">Investment</h2>
          <p className="text-sm text-gray-500">Services and pricing included in this proposal.</p>
        </div>
      </div>

      <div className="px-6 py-5">
        {editMode ? (
          <div className="space-y-3">
            {sorted.length === 0 ? (
              <p className="rounded-xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-400">
                No line items yet. Add your first service below.
              </p>
            ) : (
              sorted.map((item, index) => (
                <EditableLineItemRow
                  key={item.id}
                  item={item}
                  isFirst={index === 0}
                  isLast={index === sorted.length - 1}
                />
              ))
            )}

            <div className="relative flex flex-wrap items-center gap-3 pt-2 print:hidden">
              <button
                type="button"
                onClick={() => setCatalogOpen(v => !v)}
                className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-primary/90"
              >
                <Plus className="h-4 w-4" />
                From catalog
                <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', catalogOpen && 'rotate-180')} />
              </button>
              <button
                type="button"
                onClick={() => addLineItem()}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
              >
                <Plus className="h-4 w-4" />
                Add line item
              </button>
            </div>
            {catalogOpen && (
              <div className="max-h-56 overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 shadow-sm print:hidden">
                {catalog === null ? (
                  <p className="px-2 py-1.5 text-xs text-gray-400">Loading catalog…</p>
                ) : catalog.length === 0 ? (
                  <p className="px-2 py-1.5 text-xs text-gray-400">
                    No services in the catalog. Add them under Settings → Line Item Catalog.
                  </p>
                ) : (
                  catalog.map(t => {
                    const templateItem = catalogToTemplateItem(t);
                    const priceParts: string[] = [];
                    if (t.one_time_price) priceParts.push(formatCurrency(Number(t.one_time_price)));
                    if (t.monthly_price) priceParts.push(`${formatCurrency(Number(t.monthly_price))}/mo`);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          addLineItem(templateItem);
                          setCatalogOpen(false);
                        }}
                        className="flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left hover:bg-gray-50"
                      >
                        <span className="truncate text-sm text-gray-800">{t.name}</span>
                        <span className="shrink-0 text-xs tabular-nums text-gray-400">
                          {priceParts.join(' + ') || 'No pricing'}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        ) : pricedItems.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">No priced services in this proposal yet.</p>
        ) : (
          <div>
            <div className="mb-1 flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-gray-400">
              <span className="flex-1">Service</span>
              <span className="shrink-0">Investment</span>
            </div>
            <div className="divide-y divide-gray-100">
              {regularItems.map(item => (
                <div key={item.id}>{renderPricedItem(item, item.name)}</div>
              ))}
            </div>
            {optionalItems.length > 0 && (
              <div className={cn(regularItems.length > 0 && 'mt-6')}>
                <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Optional extras</p>
                <p className="mt-0.5 text-xs text-gray-500">
                  {canChoose
                    ? 'Tick any you would like to add. The total updates as you go.'
                    : undecided
                      ? 'Chosen by the client when signing. Not in the totals until added.'
                      : 'Chosen when the proposal was signed.'}
                </p>
                <div className="mt-1 divide-y divide-gray-100">
                  {optionalItems.map(item => (
                    <div key={item.id}>{renderPricedItem(item, optionalName(item))}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {(showOneTime || showMonthly) && (
          <div className="mt-6 border-t border-gray-200 pt-5">
            <div className="space-y-1">
              {showOneTime && (
                <SummaryTotalRow
                  label="One-time subtotal"
                  amount={formatProposalTotal(totals.oneTimeSubtotal, totals.oneTimeHasLabelOnly)}
                />
              )}
              {showMonthly && (
                <SummaryTotalRow
                  label="Monthly subtotal"
                  amount={formatProposalTotal(totals.monthlySubtotal, totals.monthlyHasLabelOnly)}
                  suffix="/mo"
                />
              )}
              {totals.oneTimeDiscount > 0 && (
                <SummaryTotalRow
                  label={discountLabel}
                  amount={`−${formatCurrency(totals.oneTimeDiscount)}`}
                  tone="discount"
                />
              )}
              {totals.monthlyDiscount > 0 && (
                <SummaryTotalRow
                  label={`${discountLabel} (monthly)`}
                  amount={`−${formatCurrency(totals.monthlyDiscount)}`}
                  suffix="/mo"
                  tone="discount"
                />
              )}
            </div>

            {editMode && (
              <div className="mt-3">
                <DiscountEditor proposal={proposal} />
              </div>
            )}

            <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50/80 px-4 py-4">
              <p className="mb-3 text-[11px] font-bold uppercase tracking-wide text-gray-500">
                Proposal total
              </p>
              <div className="space-y-1">
                {showOneTime && (
                  <SummaryTotalRow
                    label="One-time"
                    amount={formatProposalTotal(totals.oneTimeTotal, totals.oneTimeHasLabelOnly)}
                    suffix="total"
                    emphasis
                  />
                )}
                {showMonthly && (
                  <SummaryTotalRow
                    label="Monthly"
                    amount={formatProposalTotal(totals.monthlyTotal, totals.monthlyHasLabelOnly)}
                    suffix="/mo"
                    emphasis
                  />
                )}
              </div>
              {optionalItems.length > 0 && undecided && !canChoose && (
                <p className="mt-2 text-xs text-gray-500">
                  Optional extras are not in these totals until the client adds them when signing.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
      <DemoPopupModal demo={demoPopup} onClose={() => setDemoPopup(null)} />
    </section>
  );
}
