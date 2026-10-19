import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Pencil,
  Trophy,
  XCircle,
  RotateCcw,
  Clock,
  Link2,
  ExternalLink,
  PenLine,
  Printer,
  Send,
  LayoutTemplate,
} from 'lucide-react';
import AppPreloader from '../components/ui/AppPreloader';
import StatusBadge from '../components/ui/StatusBadge';
import Modal from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import ProposalDocument from '../components/proposal/ProposalDocument';
import ProposalActivityTimeline from '../components/proposal/ProposalActivityTimeline';
import SendProposalModal from '../components/proposal/SendProposalModal';
import HoverTooltip from '../components/ui/HoverTooltip';
import SignaturePad, { type SignaturePadHandle } from '../components/proposal/SignaturePad';
import { ProposalEditProvider } from '../components/proposal/edit/ProposalEditContext';
import { ProposalAgentProvider } from '../components/proposal/agent/ProposalAgentContext';
import { ProposalAgentLayout, AgentToggleButton } from '../components/proposal/agent/ProposalAgentLayout';
import ClientEditModal from '../components/client/ClientEditModal';
import { useAuth } from '../contexts/AuthContext';
import { useProposalData } from '../hooks/useProposalData';
import {
  applyDraftToProposal,
  applyEditSet,
  buildSnapshot,
  type ProposalDraftPayload,
  type ProposalEditSet,
} from '../lib/proposal-agent';
import {
  countersignProposal,
  createProposalTemplate,
  listProposalTemplates,
  markProposalLost,
  markProposalSent,
  markProposalWon,
  reopenProposal,
  updateProposal,
} from '../lib/proposals-db';
import { buildTemplateInputFromProposal } from '../lib/proposal-convert';
import { deriveProposalStatus } from '../lib/proposal-status';
import { publicProposalOrigin } from '../lib/public-origin';
import AgencySignatureCard from '../components/proposal/AgencySignatureCard';
import XeroInvoiceCard from '../components/proposal/XeroInvoiceCard';
import ProposalExpiryRow from '../components/proposal/ProposalExpiryRow';

export default function ProposalDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const { user, hasRole } = useAuth();
  const { data, loading, loadError, reload } = useProposalData(id);
  const [searchParams, setSearchParams] = useSearchParams();
  const printTriggeredRef = useRef(false);
  const [confirmAction, setConfirmAction] = useState<'won' | 'lost' | 'reopen' | null>(null);
  const [lostReason, setLostReason] = useState('');
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [countersignOpen, setCountersignOpen] = useState(false);
  const [countersignName, setCountersignName] = useState('');
  const [countersignBusy, setCountersignBusy] = useState(false);
  const [countersignError, setCountersignError] = useState('');
  const [countersignPadEmpty, setCountersignPadEmpty] = useState(true);
  const [editClientOpen, setEditClientOpen] = useState(false);
  const [editingRecipient, setEditingRecipient] = useState(false);
  const [recipientNameDraft, setRecipientNameDraft] = useState('');
  const [recipientEmailDraft, setRecipientEmailDraft] = useState('');
  const [recipient2NameDraft, setRecipient2NameDraft] = useState('');
  const [recipient2EmailDraft, setRecipient2EmailDraft] = useState('');
  const [secondSignerDraft, setSecondSignerDraft] = useState(false);
  const [recipientSaving, setRecipientSaving] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateNameDraft, setTemplateNameDraft] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [savedTemplateId, setSavedTemplateId] = useState<string | null>(null);
  const countersignPadRef = useRef<SignaturePadHandle>(null);

  useEffect(() => {
    if (!data || printTriggeredRef.current) return;
    if (searchParams.get('print') === '1') {
      printTriggeredRef.current = true;
      window.print();
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.delete('print');
        return next;
      }, { replace: true });
    }
  }, [data, searchParams, setSearchParams]);

  if (loading) return <AppPreloader />;

  if (loadError || !data) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-gray-500">{loadError || 'Proposal not found'}</p>
        <Link to="/proposals" className="text-sm font-medium text-brand-primary hover:underline">
          Back to proposals
        </Link>
      </div>
    );
  }

  const { proposal, client, lineItems, contractDocs, signatures, events, settings } = data;
  const displayStatus = deriveProposalStatus(proposal);
  const isSigned = Boolean(proposal.client_signed_at);
  const isClosed = proposal.status === 'won' || proposal.status === 'lost';
  const needsCountersign = isSigned && !proposal.countersigned_at;
  const clientSignatures = signatures.filter(s => s.role === 'client');
  const agencySignature = signatures.find(s => s.role === 'agency') ?? null;
  const hasSecondSigner = Boolean(proposal.recipient2_email);
  const requiredSigners = hasSecondSigner ? 2 : 1;
  // The signer roster freezes as soon as ANY client signature exists (DB-enforced too).
  const signersLocked = clientSignatures.length > 0 || isSigned;
  const partiallySigned = !isSigned && clientSignatures.length > 0 && clientSignatures.length < requiredSigners;
  const signerSigned = (index: number) =>
    clientSignatures.some(s => (s.signer_index ?? 1) === index);
  const publicUrl = proposal.public_token
    ? `${publicProposalOrigin()}/proposal/${proposal.public_token}`
    : null;

  const openRecipientEdit = () => {
    setRecipientNameDraft(proposal.recipient_name || '');
    setRecipientEmailDraft(proposal.recipient_email || '');
    setRecipient2NameDraft(proposal.recipient2_name || '');
    setRecipient2EmailDraft(proposal.recipient2_email || '');
    setSecondSignerDraft(Boolean(proposal.recipient2_email));
    setEditingRecipient(true);
  };

  const saveRecipient = async () => {
    if (secondSignerDraft && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient2EmailDraft.trim())) {
      toast('Please enter a valid email for the second signer, or remove them.');
      return;
    }
    setRecipientSaving(true);
    try {
      await updateProposal(proposal.id, {
        recipient_name: recipientNameDraft.trim(),
        recipient_email: recipientEmailDraft.trim(),
        recipient2_name: secondSignerDraft ? recipient2NameDraft.trim() : '',
        recipient2_email: secondSignerDraft ? recipient2EmailDraft.trim() : '',
      });
      setEditingRecipient(false);
      await reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to update recipient');
    } finally {
      setRecipientSaving(false);
    }
  };

  const copyLink = async () => {
    setLinkBusy(true);
    try {
      const updated = proposal.public_token ? proposal : await markProposalSent(proposal);
      const url = `${publicProposalOrigin()}/proposal/${updated.public_token}`;
      await navigator.clipboard.writeText(url);
      toast('Link copied. The countdown starts when the client opens it.');
      if (!proposal.public_token) await reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to copy link');
    } finally {
      setLinkBusy(false);
    }
  };

  const submitCountersign = async () => {
    setCountersignError('');
    const name = countersignName.trim() || user?.name || '';
    if (!name) {
      setCountersignError('Please type your full name.');
      return;
    }
    const image = countersignPadRef.current?.toDataURL();
    if (!image) {
      setCountersignError('Please draw your signature.');
      return;
    }
    setCountersignBusy(true);
    try {
      await countersignProposal({
        proposal_id: proposal.id,
        typed_name: name,
        signature_image: image,
      });
      setCountersignOpen(false);
      toast('Countersigned');
      await reload();
    } catch (e) {
      setCountersignError(e instanceof Error ? e.message : 'Failed to countersign');
    } finally {
      setCountersignBusy(false);
    }
  };

  const runAction = async () => {
    if (!confirmAction) return;
    setActing(true);
    setActionError('');
    try {
      if (confirmAction === 'won') await markProposalWon(proposal.id);
      else if (confirmAction === 'lost') await markProposalLost(proposal.id, lostReason.trim() || null);
      else await reopenProposal(proposal.id);
      setConfirmAction(null);
      setLostReason('');
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setActing(false);
    }
  };

  const openSaveTemplate = () => {
    setTemplateNameDraft(`${client.company_name} template`.trim());
    setSavedTemplateId(null);
    setSaveTemplateOpen(true);
  };

  const saveAsTemplate = async () => {
    const name = templateNameDraft.trim();
    if (!name) {
      toast('Please name the template.');
      return;
    }
    setSavingTemplate(true);
    try {
      const existing = await listProposalTemplates();
      const nextOrder = existing.reduce((max, t) => Math.max(max, t.display_order), 0) + 10;
      const created = await createProposalTemplate(
        buildTemplateInputFromProposal(name, proposal, lineItems, nextOrder),
      );
      setSavedTemplateId(created.id);
      toast('Template saved');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Failed to save template');
    } finally {
      setSavingTemplate(false);
    }
  };

  const onApplyEdits = isSigned
    ? undefined
    : async (edits: ProposalEditSet) => {
        await applyEditSet(proposal, lineItems, edits);
        await reload();
      };
  // A whole-proposal rewrite arrives as a draft, and it applies to this
  // proposal rather than creating a second one.
  const onApplyDraft = isSigned
    ? undefined
    : async (draft: ProposalDraftPayload) => {
        await applyDraftToProposal(proposal, lineItems, draft);
        await reload();
      };
  const agentBlockTitles = new Map(proposal.content_blocks.map(b => [b.key, b.title]));
  const agentItemNames = new Map(lineItems.map(li => [li.id, li.name]));

  return (
    <ProposalAgentProvider
      config={{
        proposalId: proposal.id,
        clientId: proposal.client_id,
        getSnapshot: () => buildSnapshot(proposal, lineItems),
        onApplyEdits,
        onApplyDraft,
      }}
    >
    <ProposalAgentLayout blockTitles={agentBlockTitles} itemNames={agentItemNames}>
    <div className="min-h-screen bg-brand-surface print:bg-white">
      <header className="sticky top-0 z-20 border-b border-gray-100 bg-white/90 backdrop-blur print:hidden">
        <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-4 px-4">
          <Link
            to="/proposals"
            className="inline-flex items-center gap-1.5 text-sm font-medium leading-none text-gray-500 hover:text-gray-900"
          >
            <ArrowLeft className="h-4 w-4" />
            Proposals
          </Link>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-gray-900">
              {client.company_name}
              <span className="ml-2 font-normal text-gray-400">
                ECD-{String(proposal.proposal_number).padStart(4, '0')}
              </span>
            </p>
          </div>
          <AgentToggleButton />
          <StatusBadge status={displayStatus} size="md" />
        </div>
      </header>

      <Modal
        open={Boolean(confirmAction)}
        title={
          confirmAction === 'won' ? 'Mark proposal as won?' :
          confirmAction === 'lost' ? 'Mark proposal as lost?' : 'Reopen proposal?'
        }
        onClose={() => (acting ? undefined : setConfirmAction(null))}
        className="max-w-lg"
      >
        <div className="p-5">
          {confirmAction === 'won' && !isSigned && (
            <p className="text-sm text-gray-700">
              This marks the proposal won without a client signature. The signature section will remain empty.
            </p>
          )}
          {confirmAction === 'won' && isSigned && (
            <p className="text-sm text-gray-700">Mark this signed proposal as won.</p>
          )}
          {confirmAction === 'lost' && (
            <div>
              <p className="text-sm text-gray-700">Optionally note why this proposal was lost:</p>
              <input
                type="text"
                value={lostReason}
                onChange={e => setLostReason(e.target.value)}
                placeholder="e.g. Went with another agency, budget cut…"
                className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
              />
            </div>
          )}
          {confirmAction === 'reopen' && (
            <p className="text-sm text-gray-700">Move this proposal back to “sent” so it can be won or lost again.</p>
          )}
          {actionError && <p className="mt-3 text-sm text-red-600">{actionError}</p>}
          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={acting}
              onClick={() => setConfirmAction(null)}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={acting}
              onClick={runAction}
              className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${
                confirmAction === 'lost' ? 'bg-red-600 hover:bg-red-700' : 'gradient-bg hover:opacity-90'
              }`}
            >
              {acting ? 'Working…' : confirmAction === 'won' ? 'Mark won' : confirmAction === 'lost' ? 'Mark lost' : 'Reopen'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={saveTemplateOpen}
        title="Save as template"
        onClose={() => (savingTemplate ? undefined : setSaveTemplateOpen(false))}
        className="max-w-lg"
      >
        <div className="p-5">
          {savedTemplateId ? (
            <div className="space-y-4">
              <p className="text-sm text-gray-700">
                Saved. The template includes this proposal's text sections, line items, discount, and
                attached contracts. Client and recipient details were left out.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setSaveTemplateOpen(false)}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Done
                </button>
                <button
                  type="button"
                  onClick={() => navigate(`/proposals/templates/${savedTemplateId}/edit`)}
                  className="rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  Edit template
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-gray-700">
                Create a reusable template from this proposal. Everything is copied except the client and
                recipient details.
              </p>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500">Template name</label>
                <input
                  type="text"
                  autoFocus
                  value={templateNameDraft}
                  onChange={e => setTemplateNameDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void saveAsTemplate();
                  }}
                  placeholder="e.g. Retainer proposal"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={savingTemplate}
                  onClick={() => setSaveTemplateOpen(false)}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={savingTemplate}
                  onClick={saveAsTemplate}
                  className="rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {savingTemplate ? 'Saving…' : 'Save template'}
                </button>
              </div>
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={countersignOpen}
        title="Countersign proposal"
        onClose={() => (countersignBusy ? undefined : setCountersignOpen(false))}
        className="max-w-lg"
      >
        <div className="space-y-3 p-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Full name</label>
            <input
              type="text"
              value={countersignName}
              onChange={e => setCountersignName(e.target.value)}
              placeholder={user?.name || 'Your full name'}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
            />
          </div>
          <SignaturePad ref={countersignPadRef} onChange={setCountersignPadEmpty} typedName={countersignName} />
          {countersignError && <p className="text-sm text-red-600">{countersignError}</p>}
          <div className="flex items-center justify-end gap-2 border-t border-gray-100 pt-4">
            <button
              type="button"
              disabled={countersignBusy}
              onClick={() => setCountersignOpen(false)}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={countersignBusy || countersignPadEmpty}
              onClick={submitCountersign}
              className="rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {countersignBusy ? 'Signing…' : 'Countersign'}
            </button>
          </div>
        </div>
      </Modal>

      <SendProposalModal
        open={sendOpen}
        proposal={proposal}
        client={client}
        onClose={() => setSendOpen(false)}
        onSent={async emailStatus => {
          toast(
            emailStatus === 'sent'
              ? 'Proposal emailed to the client'
              : 'Proposal is live. Email sending isn’t configured yet, so copy the link and send it yourself.',
          );
          await reload();
        }}
      />

      <ClientEditModal
        open={editClientOpen}
        client={client}
        onClose={() => setEditClientOpen(false)}
        onSaved={() => void reload()}
      />

      <main className="proposal-print-page mx-auto flex max-w-[1280px] flex-col gap-8 px-4 py-8 sm:px-6 lg:flex-row print:block print:max-w-none print:gap-0 print:px-0 print:py-0">
        <div className="proposal-print-content min-w-0 flex-1 print:w-full">
          <ProposalEditProvider mode="preview" proposal={proposal} lineItems={lineItems}>
            <ProposalDocument
              proposal={proposal}
              client={client}
              lineItems={lineItems}
              contractDocs={contractDocs}
              signatures={signatures}
              settings={settings}
              collapsibleContracts
            />
          </ProposalEditProvider>
        </div>

        <aside className="w-full shrink-0 space-y-4 lg:w-80 print:hidden">
          <div className="rounded-xl bg-white p-5 card-shadow">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">Client</h3>
              <button
                type="button"
                onClick={() => setEditClientOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
              >
                <Pencil className="h-3 w-3" />
                Edit client
              </button>
            </div>
            <p className="mt-2 text-sm font-medium text-gray-900">{client.company_name}</p>
            {client.name && <p className="text-xs text-gray-500">{client.name}</p>}
            {client.email && <p className="text-xs text-gray-500">{client.email}</p>}
            {client.website_url && (
              <a
                href={client.website_url}
                target="_blank"
                rel="noreferrer"
                className="mt-0.5 block truncate text-xs text-brand-primary hover:underline"
              >
                {client.website_url}
              </a>
            )}
          </div>

          <div className="rounded-xl bg-white p-5 card-shadow">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">
                {hasSecondSigner ? 'Recipients' : 'Recipient'}
              </h3>
              {!signersLocked && !editingRecipient && (
                <button
                  type="button"
                  onClick={openRecipientEdit}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
                >
                  <Pencil className="h-3 w-3" />
                  Edit
                </button>
              )}
            </div>
            <p className="mt-1 text-[11px] text-gray-400">
              Who this proposal is addressed and sent to. Set independently of the client record.
              {hasSecondSigner ? ' Each signer receives their own signing link.' : ''}
            </p>
            {editingRecipient ? (
              <div className="mt-3 space-y-2.5">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-gray-500">Name</label>
                  <input
                    type="text"
                    autoFocus
                    value={recipientNameDraft}
                    onChange={e => setRecipientNameDraft(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-gray-500">Email</label>
                  <input
                    type="email"
                    value={recipientEmailDraft}
                    onChange={e => setRecipientEmailDraft(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
                  />
                </div>
                {(client.name || client.email) && (
                  <button
                    type="button"
                    onClick={() => {
                      if (client.name) setRecipientNameDraft(client.name);
                      if (client.email) setRecipientEmailDraft(client.email);
                    }}
                    className="text-xs font-medium text-brand-primary hover:underline"
                  >
                    Copy from client ({client.name || client.email})
                  </button>
                )}
                {secondSignerDraft ? (
                  <div className="space-y-2.5 rounded-lg border border-gray-100 bg-gray-50/60 p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Second signer</p>
                      <button
                        type="button"
                        onClick={() => {
                          setSecondSignerDraft(false);
                          setRecipient2NameDraft('');
                          setRecipient2EmailDraft('');
                        }}
                        className="text-[11px] font-medium text-red-500 hover:underline"
                      >
                        Remove
                      </button>
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-gray-500">Name</label>
                      <input
                        type="text"
                        value={recipient2NameDraft}
                        onChange={e => setRecipient2NameDraft(e.target.value)}
                        className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-gray-500">Email</label>
                      <input
                        type="email"
                        value={recipient2EmailDraft}
                        onChange={e => setRecipient2EmailDraft(e.target.value)}
                        className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
                      />
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setSecondSignerDraft(true)}
                    className="text-xs font-medium text-brand-primary hover:underline"
                  >
                    + Add second signer
                  </button>
                )}
                <div className="flex items-center gap-2 pt-0.5">
                  <button
                    type="button"
                    onClick={saveRecipient}
                    disabled={recipientSaving}
                    className="text-xs font-medium text-brand-primary hover:underline disabled:opacity-50"
                  >
                    {recipientSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingRecipient(false)}
                    disabled={recipientSaving}
                    className="text-xs text-gray-500 hover:text-gray-700"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="mt-2 flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{proposal.recipient_name || '—'}</p>
                    <p className="text-xs text-gray-500">{proposal.recipient_email || '—'}</p>
                  </div>
                  {hasSecondSigner && signerSigned(1) && (
                    <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                      Signed
                    </span>
                  )}
                </div>
                {hasSecondSigner && (
                  <div className="mt-2.5 flex items-start justify-between gap-2 border-t border-gray-100 pt-2.5">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{proposal.recipient2_name || '—'}</p>
                      <p className="text-xs text-gray-500">{proposal.recipient2_email || '—'}</p>
                    </div>
                    {signerSigned(2) && (
                      <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                        Signed
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
            {signersLocked && (
              <p className="mt-2 text-[11px] text-amber-600">
                Locked: a client signature has been recorded, so the signers on record cannot be changed.
              </p>
            )}
          </div>

          <div className="rounded-xl bg-white p-5 card-shadow">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">Status</h3>
              <StatusBadge status={displayStatus} />
            </div>
            <dl className="mt-3 space-y-1.5 text-xs">
              <div className="flex justify-between">
                <dt className="text-gray-400">Created</dt>
                <dd className="text-gray-700">{new Date(proposal.created_at).toLocaleDateString()}</dd>
              </div>
              {proposal.sent_at && (
                <div className="flex justify-between">
                  <dt className="text-gray-400">Sent</dt>
                  <dd className="text-gray-700">{new Date(proposal.sent_at).toLocaleDateString()}</dd>
                </div>
              )}
              {proposal.first_viewed_at && (
                <div className="flex justify-between">
                  <dt className="text-gray-400">First viewed</dt>
                  <dd className="text-gray-700">{new Date(proposal.first_viewed_at).toLocaleDateString()}</dd>
                </div>
              )}
              {!isClosed && (
                <div className="flex items-start justify-between gap-2">
                  <dt className="text-gray-400">Expires</dt>
                  <dd className="text-right">
                    <ProposalExpiryRow
                      proposal={proposal}
                      validDays={settings?.defaults?.valid_days || 30}
                      onExtended={() => void reload()}
                    />
                  </dd>
                </div>
              )}
              {proposal.client_signed_at && (
                <div className="flex justify-between">
                  <dt className="text-gray-400">Client signed</dt>
                  <dd className="text-gray-700">{new Date(proposal.client_signed_at).toLocaleDateString()}</dd>
                </div>
              )}
              {partiallySigned && (
                <div className="flex justify-between">
                  <dt className="text-gray-400">Signatures</dt>
                  <dd className="font-medium text-amber-600">
                    {clientSignatures.length} of {requiredSigners}
                  </dd>
                </div>
              )}
              {proposal.lost_reason && (
                <div className="flex justify-between gap-3">
                  <dt className="shrink-0 text-gray-400">Lost reason</dt>
                  <dd className="text-right text-gray-700">{proposal.lost_reason}</dd>
                </div>
              )}
            </dl>
            {displayStatus === 'expired' && (
              <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                <Clock className="mt-0.5 h-3 w-3 shrink-0" />
                This proposal passed its valid-until date. Extend validity when sending again.
              </p>
            )}
          </div>

          <div className="rounded-xl bg-white p-5 card-shadow">
            <h3 className="text-sm font-semibold text-gray-900">Actions</h3>
            <div className="mt-3 space-y-2">
              {!isSigned && (
                <button
                  type="button"
                  onClick={() => navigate(`/proposals/${proposal.id}/edit`)}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit proposal
                </button>
              )}
              {/* The button name reads as "send now", and it is not: it opens a
                  preview with its own send. Worth saying on hover so nobody
                  hesitates over a button they think is irreversible. */}
              {!isClosed && (
                <HoverTooltip label="Opens a preview first" description="You will see the exact email and recipient before anything sends. Nothing goes out until you confirm." className="w-full">
                  <button
                    type="button"
                    onClick={() => setSendOpen(true)}
                    className="flex w-full items-center justify-center gap-2 rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                  >
                    <Send className="h-3.5 w-3.5" />
                    {proposal.status === 'draft' ? 'Send to client' : 'Resend'}
                  </button>
                </HoverTooltip>
              )}
              {needsCountersign && (
                <button
                  type="button"
                  onClick={() => {
                    setCountersignName(user?.name ?? '');
                    setCountersignOpen(true);
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90"
                >
                  <PenLine className="h-3.5 w-3.5" />
                  Countersign
                </button>
              )}
              <AgencySignatureCard
                proposalId={proposal.id}
                signature={agencySignature}
                clientHasSigned={isSigned}
                currentUserId={user?.id ?? null}
                onChanged={reload}
              />
              {/* Only meaningful once signed: that is when the draft is created. */}
              {isSigned && <XeroInvoiceCard proposal={proposal} lineItems={lineItems} onChanged={reload} />}
              <button
                type="button"
                disabled={linkBusy}
                // No confirmation: copying a link is not a commitment any more,
                // because the validity window only starts when the client opens it.
                onClick={copyLink}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                <Link2 className="h-3.5 w-3.5" />
                {linkBusy ? 'Working…' : 'Copy client link'}
              </button>
              {publicUrl && (
                <a
                  href={`${publicUrl}?preview=1`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open client view
                </a>
              )}
              <button
                type="button"
                onClick={() => window.print()}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                <Printer className="h-3.5 w-3.5" />
                Download PDF
              </button>
              {hasRole('admin') && (
                <button
                  type="button"
                  onClick={openSaveTemplate}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
                >
                  <LayoutTemplate className="h-3.5 w-3.5" />
                  Save as template
                </button>
              )}
              {!isClosed && (
                <button
                  type="button"
                  onClick={() => setConfirmAction('won')}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-emerald-200 px-4 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
                >
                  <Trophy className="h-3.5 w-3.5" />
                  Mark won
                </button>
              )}
              {!isClosed && (
                <button
                  type="button"
                  onClick={() => setConfirmAction('lost')}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Mark lost
                </button>
              )}
              {proposal.status === 'lost' && (
                <button
                  type="button"
                  onClick={() => setConfirmAction('reopen')}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reopen
                </button>
              )}
            </div>
          </div>

          <div className="rounded-xl bg-white p-5 card-shadow">
            <h3 className="mb-3 text-sm font-semibold text-gray-900">Activity</h3>
            <ProposalActivityTimeline events={events} />
          </div>
        </aside>
      </main>
    </div>
    </ProposalAgentLayout>
    </ProposalAgentProvider>
  );
}
