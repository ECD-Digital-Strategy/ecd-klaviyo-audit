import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, Settings2 } from 'lucide-react';
import type { Audit, AuditSection, Client, ShopifyDataSnapshot, WebPageSnapshot, WebPageType } from '../../lib/types';
import { parseWebRoadmapDetail, type OrdersRollup } from '../../lib/web-report-details';
import { getAddOnItemsFromLayout } from '../../lib/addon-highlight';
import { addOnIsCustomerAgent, addOnIsHelpdesk } from '../../lib/customer-agent-demo';
import { useReportEdit } from './edit/ReportEditContext';
import ReportSectionEditChrome from './edit/ReportSectionEditChrome';
import EditablePlainText from './edit/EditablePlainText';
import WebPageSection from './web/WebPageSection';
import WebAnalyticsSection from './web/WebAnalyticsSection';
import WebRoadmapTable from './web/WebRoadmapTable';
import WebInvestmentSummary from './web/WebInvestmentSummary';
import ReportCover from './ReportCover';
import WebAgentDemoSection, { type AgentDemoKind } from './web/WebAgentDemoSection';
import { OutreachTeaserBanner, isTeaser } from './web/OutreachTeaser';

export interface WebAuditReportViewData {
  audit: Audit;
  client: Client;
  sections: AuditSection[];
  pageSnapshots: WebPageSnapshot[];
  shopifySnapshots: ShopifyDataSnapshot[];
}

const PAGE_SECTIONS: Array<{ key: string; title: string; page_type: WebPageType }> = [
  { key: 'web_homepage', title: 'Homepage', page_type: 'homepage' },
  { key: 'web_product_page', title: 'Product Page', page_type: 'product' },
  { key: 'web_collection_page', title: 'Collection Page', page_type: 'collection' },
  { key: 'web_cart', title: 'Cart', page_type: 'cart' },
];

function isHidden(section: AuditSection | undefined): boolean {
  if (!section) return false;
  const cfg = section.section_config as Record<string, unknown> | null | undefined;
  const inner = cfg?.[section.section_key] as Record<string, unknown> | undefined;
  return inner?.hidden === true;
}

/** Numbered section frame, matching the Klaviyo report's section language so a
 * client moving between the two reports sees one house style. */
function WebSectionShell({
  id,
  number,
  label,
  setRef,
  children,
  action,
  hidden = false,
  onToggleHidden,
}: {
  id: string;
  number: string;
  label: string;
  setRef: (id: string, el: HTMLElement | null) => void;
  children: React.ReactNode;
  /** Editor-only control belonging to this section, sat on the right of its
   *  heading rather than floating at the end of the report. */
  action?: React.ReactNode;
  /** Taken off the client report, as on the Klaviyo report. The editor still
   *  sees a placeholder with a button to put it back. */
  hidden?: boolean;
  onToggleHidden?: (hidden: boolean) => void;
}) {
  const { editMode } = useReportEdit();
  if (hidden) {
    if (!editMode || !onToggleHidden) return null;
    return (
      <section id={id} ref={el => setRef(id, el)} className="scroll-mt-24 print:hidden">
        <ReportSectionEditChrome label={label} hidden onToggleHidden={onToggleHidden}>
          {null}
        </ReportSectionEditChrome>
      </section>
    );
  }
  const hideButton = editMode && onToggleHidden ? (
    <button
      type="button"
      onClick={() => onToggleHidden(true)}
      title="Hide section from report"
      className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-600 shadow-sm transition-colors hover:border-amber-300 hover:text-amber-700"
    >
      <Eye className="h-4 w-4" />
    </button>
  ) : null;
  return (
    <section id={id} ref={el => setRef(id, el)} className="scroll-mt-24">
      <div className="mb-6 flex min-w-0 items-center gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-primary text-sm font-bold text-white tabular-nums shadow-sm shadow-brand-primary/25">
          {number}
        </span>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brand-primary/80">
            Section {number}
          </p>
          <h2 className="text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">{label}</h2>
        </div>
        {action || hideButton ? (
          <div className="ml-auto flex shrink-0 items-center gap-2 print:hidden">
            {action}
            {hideButton}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** Opens the shared add-ons drawer. Lives in two places depending on whether
 *  there is an add-on section to sit beside, so it is defined once. */
function ManageAddOnsButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50"
    >
      <Settings2 className="h-3.5 w-3.5" aria-hidden />
      {label}
    </button>
  );
}

/** Intro block for the web_overview section (executive summary only; page-level
 * strengths live on each page's "What works"). */
function OverviewBlock({ section, companyName }: { section: AuditSection; companyName: string }) {
  const { editMode, updateSectionField } = useReportEdit();

  return (
    <div className="rounded-2xl bg-white p-6 card-shadow sm:p-7">
      {(editMode || section.summary_text) && (
        <div className="text-[15px] leading-relaxed text-gray-600">
          <EditablePlainText
            value={section.summary_text ?? ''}
            onSave={(v) => updateSectionField(section.section_key, 'summary_text', v)}
            placeholder={`A short summary of ${companyName}'s storefront…`}
          />
        </div>
      )}
    </div>
  );
}

/** The most recently fetched snapshot of a kind.
 *
 * Every refetch inserts a new row rather than replacing one, so picking with a
 * plain find() meant the report showed whichever row its caller's query happened
 * to return first. The internal view ordered newest-first and looked right; the
 * public link did not order at all and served a client a stale window. Deciding
 * it here means no caller can get this wrong again. */
function newestSnapshot<T extends { snapshot_kind: string; fetched_at?: string | null }>(
  rows: T[],
  kind: string,
): T | undefined {
  let best: T | undefined;
  for (const row of rows) {
    if (row.snapshot_kind !== kind) continue;
    if (!best || String(row.fetched_at ?? '') > String(best.fetched_at ?? '')) best = row;
  }
  return best;
}

export default function WebAuditReportView({
  data,
  onManageAddOns,
}: {
  data: WebAuditReportViewData;
  /** Opens the shared add-ons editor, the same drawer the Klaviyo report uses. */
  onManageAddOns?: () => void;
}) {
  const { audit, client, sections, pageSnapshots, shopifySnapshots } = data;
  const { editMode, toggleAuditSectionHidden } = useReportEdit();
  const byKey = new Map(sections.map((s) => [s.section_key, s]));

  // Customer Agent and Helpdesk share one demo app, so selecting both gets a
  // single combined section rather than the same embed twice.
  const addOnItems = useMemo(
    () => getAddOnItemsFromLayout(audit.layout).filter(item => !item.is_hidden),
    [audit.layout],
  );

  const demoKind = useMemo<AgentDemoKind | null>(() => {
    const items = addOnItems;
    const hasAgent = items.some(item => addOnIsCustomerAgent(item.template_slug, item.name));
    const hasHelpdesk = items.some(item => addOnIsHelpdesk(item.template_slug, item.name));
    if (hasAgent && hasHelpdesk) return 'both';
    if (hasAgent) return 'agent';
    if (hasHelpdesk) return 'helpdesk';
    return null;
    // audit.layout, not audit.report_layout: the latter does not exist on Audit,
    // so the memo never recomputed and toggling an add-on left the section stale.
  }, [audit.layout]);

  const demoLabel = demoKind === 'helpdesk' ? 'Helpdesk' : demoKind === 'both' ? 'Agent & Helpdesk' : 'Customer Agent';

  // The page sections in this audit's order, with any renamed titles. A client
  // who asked us to focus on the cart (Simple & Dainty) gets it first, titled
  // for what it covers. Set in audit.layout; without it the default order holds.
  const pageSections = useMemo(() => {
    const layout = (audit.layout ?? {}) as { web_page_order?: unknown; web_section_titles?: unknown };
    const order = Array.isArray(layout.web_page_order) ? layout.web_page_order.map(String) : [];
    const titles = (layout.web_section_titles && typeof layout.web_section_titles === 'object'
      ? layout.web_section_titles
      : {}) as Record<string, unknown>;
    const rank = (key: string) => {
      const i = order.indexOf(key);
      return i === -1 ? order.length + PAGE_SECTIONS.findIndex((p) => p.key === key) : i;
    };
    return [...PAGE_SECTIONS]
      .sort((a, b) => rank(a.key) - rank(b.key))
      .map((p) => ({ ...p, title: typeof titles[p.key] === 'string' && titles[p.key] ? String(titles[p.key]) : p.title }));
  }, [audit.layout]);

  const overview = byKey.get('web_overview');
  const performance = byKey.get('web_performance');
  const roadmap = byKey.get('web_revenue_summary');

  const rollup =
    (newestSnapshot(shopifySnapshots, 'orders_rollup')?.computed as OrdersRollup | undefined) ?? null;

  // Only sections that actually render get a nav entry, so the nav never points
  // at an anchor that is not on the page.
  const navItems = useMemo(() => {
    const items: Array<{ id: string; label: string }> = [];
    if (overview && !isHidden(overview)) items.push({ id: 'web_overview', label: 'Overview' });
    for (const { key, title, page_type } of pageSections) {
      const section = byKey.get(key);
      if (!section || isHidden(section)) continue;
      if (!pageSnapshots.some((s) => s.page_type === page_type)) continue;
      items.push({ id: key, label: title });
    }
    if (performance && !isHidden(performance)) items.push({ id: 'web_performance', label: 'Performance' });
    // Before the roadmap: the demo is context for what is being recommended,
    // and the roadmap reads as the closing summary.
    if (demoKind) items.push({ id: 'web_agent_demo', label: demoLabel });
    if (roadmap && !isHidden(roadmap)) items.push({ id: 'web_revenue_summary', label: 'Roadmap' });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, pageSnapshots, demoKind, demoLabel, pageSections]);

  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const setRef = (id: string, el: HTMLElement | null) => { sectionRefs.current[id] = el; };
  const [activeSection, setActiveSection] = useState<string>(navItems[0]?.id ?? '');
  const [scrollProgress, setScrollProgress] = useState(0);

  useEffect(() => {
    const onScroll = () => {
      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      const pct = max > 0 ? (doc.scrollTop / max) * 100 : 0;
      setScrollProgress(Math.max(0, Math.min(100, pct)));
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  useEffect(() => {
    const observers: IntersectionObserver[] = [];
    navItems.forEach(({ id }) => {
      const el = sectionRefs.current[id];
      if (!el) return;
      const observer = new IntersectionObserver(
        ([entry]) => { if (entry.isIntersecting) setActiveSection(id); },
        { rootMargin: '-20% 0px -70% 0px' },
      );
      observer.observe(el);
      observers.push(observer);
    });
    return () => observers.forEach(o => o.disconnect());
  }, [navItems]);

  let sectionNumber = 0;
  const nextNumber = () => String(++sectionNumber).padStart(2, '0');

  return (
    // Light surface behind the white cards, matching the Klaviyo report. On pure
    // white the cards had no edge at all and the whole page read as one sheet.
    <div className="min-h-screen bg-brand-surface">
      {navItems.length > 1 && (
        <div className="sticky top-0 z-40 bg-white">
          <div className="border-b border-gray-100">
            <div className="mx-auto max-w-[81rem] px-6">
              <nav className="flex overflow-x-auto">
                {navItems.map(item => (
                  <a
                    key={item.id}
                    href={`#${item.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      setActiveSection(item.id);
                      const el = sectionRefs.current[item.id] ?? document.getElementById(item.id);
                      if (!el) return;
                      const top = el.getBoundingClientRect().top + window.scrollY - 72;
                      window.scrollTo({ top, behavior: 'smooth' });
                    }}
                    className={`whitespace-nowrap border-b-2 px-4 py-3.5 text-xs font-semibold transition-colors ${
                      activeSection === item.id
                        ? 'border-brand-primary text-brand-primary'
                        : 'border-transparent text-gray-500 hover:text-gray-800'
                    }`}
                  >
                    {item.label}
                  </a>
                ))}
              </nav>
            </div>
          </div>
          {/* Reading-progress line, below the nav's divider so it never overlaps
              the active tab's underline. */}
          <div
            className="h-0.5 bg-brand-primary transition-[width] duration-150 ease-out"
            style={{ width: `${scrollProgress}%` }}
            aria-hidden
          />
        </div>
      )}

      <div className="mx-auto max-w-[81rem] space-y-14 px-6 py-10">
        <ReportCover
          companyName={client.company_name}
          preparedDate={new Date(audit.created_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
          websiteUrl={client.website_url}
          brandSubtitle="Website Audit Report"
          deliverable="Website Audit"
          description="A page-by-page review of your storefront on desktop and mobile. What is working, what is costing you orders, and what to fix first."
        />
        {isTeaser(sections) && <OutreachTeaserBanner sections={sections} companyName={client.company_name} />}

        {overview && (
          <WebSectionShell
            id="web_overview"
            number={isHidden(overview) ? '' : nextNumber()}
            label="Overview"
            setRef={setRef}
            hidden={isHidden(overview)}
            onToggleHidden={(h) => toggleAuditSectionHidden('web_overview', h)}
          >
            <OverviewBlock section={overview} companyName={client.company_name} />
          </WebSectionShell>
        )}

        {pageSections.map(({ key, title, page_type }) => {
          const section = byKey.get(key);
          if (!section) return null;
          const snapshots = pageSnapshots.filter((s) => s.page_type === page_type);
          if (!snapshots.length) return null;
          const hidden = isHidden(section);
          return (
            <WebSectionShell
              key={key}
              id={key}
              number={hidden ? '' : nextNumber()}
              label={title}
              setRef={setRef}
              hidden={hidden}
              onToggleHidden={(h) => toggleAuditSectionHidden(key, h)}
            >
              <WebPageSection section={section} title={title} snapshots={snapshots} hideTitle />
            </WebSectionShell>
          );
        })}

        {/* Why the performance section is absent, stated once for whoever picks
            this audit up later. Editor-only: a client never needs to read about
            a connection they were not part of. */}
        {editMode && !rollup && (
          <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <span className="font-medium">No store data on this audit.</span> It was run without a Shopify connection,
            so there is no performance section: no revenue, orders, AOV, repeat rate or best sellers. Connect the store
            and re-run the fetch to add it.
          </div>
        )}

        {performance && (
          <WebSectionShell
            id="web_performance"
            number={isHidden(performance) ? '' : nextNumber()}
            label="Performance"
            setRef={setRef}
            hidden={isHidden(performance)}
            onToggleHidden={(h) => toggleAuditSectionHidden('web_performance', h)}
          >
            <WebAnalyticsSection section={performance} rollup={rollup} hideTitle />
          </WebSectionShell>
        )}

        {demoKind && (
          <WebSectionShell
            id="web_agent_demo"
            number={nextNumber()}
            label={demoKind === 'helpdesk' ? 'Helpdesk' : demoKind === 'both' ? 'Customer Agent and Helpdesk' : 'Customer Agent'}
            setRef={setRef}
            // The add-ons ARE this section, so the control sits on its heading
            // rather than at the foot of the report, where it was a long scroll
            // from the thing it edits.
            action={editMode && onManageAddOns ? <ManageAddOnsButton onClick={onManageAddOns} label="Manage add-ons" /> : undefined}
          >
            <WebAgentDemoSection kind={demoKind} websiteUrl={client.website_url} />
          </WebSectionShell>
        )}

        {roadmap && (
          <WebSectionShell
            id="web_revenue_summary"
            number={isHidden(roadmap) ? '' : nextNumber()}
            label="Prioritized Roadmap"
            setRef={setRef}
            hidden={isHidden(roadmap)}
            onToggleHidden={(h) => toggleAuditSectionHidden('web_revenue_summary', h)}
          >
            <WebRoadmapTable section={roadmap} title="Prioritized Roadmap" hideTitle />
          </WebSectionShell>
        )}

        {/* What the ticked roadmap rows add up to. Not its own numbered section:
            it is the bill for the section above, and numbering it would imply a
            separate piece of analysis. */}
        {roadmap && !isHidden(roadmap) && !parseWebRoadmapDetail(roadmap.section_details).investment_hidden && (
          <div id="web_investment_summary">
            <WebInvestmentSummary section={roadmap} addOns={addOnItems} />
          </div>
        )}

        {/* With no demo section there is no heading to hang this off, so the
            invitation to add one stays at the foot of the report. */}
        {editMode && onManageAddOns && !demoKind && (
          <div className="flex justify-center">
            <ManageAddOnsButton onClick={onManageAddOns} label="Add Customer Agent or Helpdesk" />
          </div>
        )}

        <p className="text-center text-[11px] text-gray-400">
          {audit.title} · {new Date(audit.created_at).toLocaleDateString()}
        </p>
      </div>
    </div>
  );
}
