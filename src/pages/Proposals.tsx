import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarRange, ChevronDown, FileSignature, LayoutTemplate, FileCheck2, Plus, Settings2 } from 'lucide-react';
import TopBar from '../components/layout/TopBar';
import GlobalSearch from '../components/ui/GlobalSearch';
import ProposalList from '../components/proposal/ProposalList';
import ProposalKPIs from '../components/proposal/ProposalKPIs';
import ProposalTemplatesPanel from '../components/proposal/ProposalTemplatesPanel';
import ContractDocsPanel from '../components/proposal/ContractDocsPanel';
import ProposalSettingsPanel from '../components/proposal/ProposalSettingsPanel';
import ClientPickerModal from '../components/proposal/agent/ClientPickerModal';
import { SkeletonTable } from '../components/ui/Skeleton';
import { ProposalAgentProvider, useProposalAgent } from '../components/proposal/agent/ProposalAgentContext';
import { ProposalAgentLayout, AgentToggleButton } from '../components/proposal/agent/ProposalAgentLayout';
import { listProposals } from '../lib/proposals-db';
import { availableYears, type ProposalYear } from '../lib/proposal-year';
import { applyDraftAsNewProposal, ApplyCancelled, type ProposalDraftPayload } from '../lib/proposal-agent';
import { linkConversationToProposal } from '../lib/proposal-agent-db';
import type { Client, Proposal } from '../lib/types';

const TABS = [
  { id: 'overview', label: 'Overview', icon: FileSignature },
  { id: 'templates', label: 'Templates', icon: LayoutTemplate },
  { id: 'contracts', label: 'Contract Docs', icon: FileCheck2 },
  { id: 'settings', label: 'Settings', icon: Settings2 },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** The analytics window, sat at the end of the tab row.
 *
 *  A native <select> would have been quicker, but it renders in the OS chrome
 *  and looks like a form field dropped into a nav bar. This is the same shape
 *  and weight as the tabs beside it, so the row reads as one control strip. */
function YearPicker({
  value,
  onChange,
  years,
}: {
  value: ProposalYear;
  onChange: (year: ProposalYear) => void;
  years: number[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Close on an outside click or Escape, the way every other menu here behaves.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const options: ProposalYear[] = [...years, 'all'];
  const labelFor = (v: ProposalYear) => (v === 'all' ? 'All time' : String(v));

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
          open
            ? 'border-brand-primary/30 bg-brand-primary/10 text-brand-primary'
            : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50'
        }`}
      >
        <CalendarRange className="h-4 w-4 text-brand-primary" />
        <span className="tabular-nums">{labelFor(value)}</span>
        <ChevronDown className={`h-3.5 w-3.5 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-30 mt-1.5 min-w-[9rem] overflow-hidden rounded-xl border border-gray-100 bg-white py-1 shadow-lg"
        >
          {options.map(opt => {
            const selected = opt === value;
            return (
              <button
                key={String(opt)}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => { onChange(opt); setOpen(false); }}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
                  selected
                    ? 'bg-brand-primary/10 font-semibold text-brand-primary'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <span className="tabular-nums">{labelFor(opt)}</span>
                {selected && <span className="ml-3 h-1.5 w-1.5 rounded-full bg-brand-primary" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * /proposals?chat=<id> opens that AI Assistant chat. It is the link Claude
 * hands over after drafting a proposal through the ECD Hub connector in
 * Athena (Emil, 2026-10-27): the draft waits here as an ordinary draft card,
 * so Apply runs this page's own create path, client picker, contracts and
 * agency signature included. The parameter is dropped once read, so a reload
 * does not reopen it.
 */
function OpenChatFromLink() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { open, selectConversation } = useProposalAgent();
  const chat = searchParams.get('chat');
  useEffect(() => {
    if (!chat) return;
    const next = new URLSearchParams(searchParams);
    next.delete('chat');
    setSearchParams(next, { replace: true });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chat)) return;
    open();
    void selectConversation(chat);
  }, [chat, searchParams, setSearchParams, open, selectConversation]);
  return null;
}

export default function Proposals() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: TabId = TABS.some(t => t.id === tabParam) ? (tabParam as TabId) : 'overview';

  const openNewProposal = () =>
    navigate('/proposals/new', { state: { backgroundLocation: location } });

  // Defaults to this year, which is the question anyone opening the dashboard
  // is actually asking. Kept in the URL so a filtered view can be shared.
  const yearParam = searchParams.get('year');
  const year: ProposalYear = yearParam === 'all' ? 'all' : Number(yearParam) || new Date().getFullYear();
  const setYear = (next: ProposalYear) => {
    const params = new URLSearchParams(searchParams);
    if (next === new Date().getFullYear()) params.delete('year');
    else params.set('year', String(next));
    setSearchParams(params, { replace: true });
  };

  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError('');
        const data = await listProposals();
        if (cancelled) return;
        setProposals(data);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load proposals');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const years = availableYears(proposals);

  // When the assistant proposes a draft with no client resolved, open a picker
  // and resolve/reject the Apply promise based on the user's choice.
  const [clientPickerOpen, setClientPickerOpen] = useState(false);
  const pickerResolve = useRef<((client: Client) => void) | null>(null);
  const pickerReject = useRef<((err: Error) => void) | null>(null);

  const applyDraftForClient = async (
    draft: ProposalDraftPayload,
    conversationId: string,
    client: Client,
  ) => {
    const filledDraft: ProposalDraftPayload = {
      ...draft,
      recipient_name: draft.recipient_name || client.name || '',
      recipient_email: draft.recipient_email || client.email || '',
    };
    const proposal = await applyDraftAsNewProposal(filledDraft, client.id);
    if (conversationId) {
      await linkConversationToProposal(conversationId, proposal.id).catch(() => {});
    }
    navigate(`/proposals/${proposal.id}/edit`);
  };

  const onApplyDraft = async (draft: ProposalDraftPayload, conversationId: string) => {
    if (draft.client_id) {
      const proposal = await applyDraftAsNewProposal(draft, draft.client_id);
      if (conversationId) {
        await linkConversationToProposal(conversationId, proposal.id).catch(() => {});
      }
      navigate(`/proposals/${proposal.id}/edit`);
      return;
    }
    // No client resolved: let the user pick one.
    const client = await new Promise<Client>((resolve, reject) => {
      pickerResolve.current = resolve;
      pickerReject.current = reject;
      setClientPickerOpen(true);
    });
    await applyDraftForClient(draft, conversationId, client);
  };

  const closeClientPicker = () => {
    setClientPickerOpen(false);
    pickerReject.current?.(new ApplyCancelled());
    pickerResolve.current = null;
    pickerReject.current = null;
  };

  const selectClientForDraft = (client: Client) => {
    setClientPickerOpen(false);
    const resolve = pickerResolve.current;
    pickerResolve.current = null;
    pickerReject.current = null;
    resolve?.(client);
  };

  return (
    <ProposalAgentProvider config={{ proposalId: null, onApplyDraft }}>
    <OpenChatFromLink />
    <ClientPickerModal open={clientPickerOpen} onClose={closeClientPicker} onSelect={selectClientForDraft} />
    <ProposalAgentLayout>
    <div>
      <TopBar
        title="Proposals"
        subtitle={`${proposals.length} total proposals`}
        hideSearch
        actions={
          <div className="flex items-center gap-3">
            <GlobalSearch />
            <button
              onClick={openNewProposal}
              className="flex items-center gap-2 px-4 py-2 gradient-bg text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              New Proposal
            </button>
            <AgentToggleButton className="px-4 py-2 text-sm" />
          </div>
        }
      />

      <div className="p-8 animate-fade-in">
        <div className="flex items-center gap-2 mb-6 border-b border-gray-100 pb-3">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setSearchParams(t.id === 'overview' ? {} : { tab: t.id }, { replace: true })}
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
          {/* The window the figures below answer for. Only on Overview, since
              Templates, Contract Docs and Settings have nothing to filter. */}
          {tab === 'overview' && (
            <div className="ml-auto">
              <YearPicker value={year} onChange={setYear} years={years} />
            </div>
          )}
        </div>

        {tab === 'overview' && (
          <>
            {error && (
              <div className="mb-6 text-sm text-red-600 bg-red-50 px-4 py-2.5 rounded-lg">{error}</div>
            )}
            {loading ? (
              <SkeletonTable rows={5} cols={6} />
            ) : (
              <>
              {proposals.length > 0 && <ProposalKPIs proposals={proposals} year={year} />}
              <ProposalList
                proposals={proposals}
                onDeleted={id => setProposals(prev => prev.filter(p => p.id !== id))}
                onUpdated={updated => setProposals(prev => prev.map(p => (p.id === updated.id ? updated : p)))}
                emptyAction={
                  <button
                    onClick={openNewProposal}
                    className="flex items-center gap-2 px-5 py-2.5 gradient-bg text-white text-sm font-medium rounded-lg hover:opacity-90 transition-opacity"
                  >
                    <Plus className="w-4 h-4" />
                    Create First Proposal
                  </button>
                }
              />
              </>
            )}
          </>
        )}
        {tab === 'templates' && <ProposalTemplatesPanel />}
        {tab === 'contracts' && <ContractDocsPanel />}
        {tab === 'settings' && <ProposalSettingsPanel />}
      </div>
    </div>
    </ProposalAgentLayout>
    </ProposalAgentProvider>
  );
}
