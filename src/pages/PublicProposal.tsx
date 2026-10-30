import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { CheckCircle2, Clock, Download, FileX2, PenLine } from 'lucide-react';
import AppPreloader from '../components/ui/AppPreloader';
import ProposalDocument from '../components/proposal/ProposalDocument';
import SignaturePad, { type SignaturePadHandle } from '../components/proposal/SignaturePad';
import BrandedCheckbox from '../components/ui/BrandedCheckbox';
import { ProposalEditProvider } from '../components/proposal/edit/ProposalEditContext';
import { ProposalOptionsProvider } from '../components/proposal/ProposalOptions';
import {
  DEFAULT_PROPOSAL_SETTINGS,
  fetchPublicProposal,
  mergeProposalSettings,
  signProposalPublic,
  type PublicProposalPayload,
} from '../lib/proposals-db';
import { computeProposalTotals, formatProposalTotal, proposalDiscountFromRow } from '../lib/proposal-pricing';
import type { Client, Proposal, ProposalSignature } from '../lib/types';

function FullScreenNotice({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof FileX2;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f9f9f9] p-6">
      <div className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-8 text-center shadow-sm">
        <Icon className="mx-auto mb-4 h-10 w-10 text-gray-300" />
        <h1 className="mb-2 text-lg font-bold text-gray-900">{title}</h1>
        <p className="text-sm leading-relaxed text-gray-500">{description}</p>
      </div>
    </div>
  );
}

/** Widen the public payload into the shapes the shared document tree renders. */
function toDocumentModels(payload: PublicProposalPayload): {
  proposal: Proposal;
  client: Client;
  signatures: ProposalSignature[];
} {
  const proposal = {
    id: 'public',
    client_id: 'public',
    audit_id: null,
    template_id: null,
    public_token: null,
    public_token2: null,
    first_viewed_at: null,
    won_at: null,
    lost_at: null,
    lost_reason: null,
    created_by: null,
    updated_at: payload.proposal.created_at,
    ...payload.proposal,
  } as Proposal;
  const client = {
    id: 'public',
    name: payload.proposal.recipient_name,
    company_name: payload.client.company_name,
    website_url: payload.client.website_url ?? '',
    industry: '',
    esp_platform: '',
    created_by: '',
    created_at: payload.proposal.created_at,
  } as Client;
  const signatures = payload.signatures.map((sig, index) => ({
    id: `sig-${index}`,
    proposal_id: 'public',
    signer_email: '',
    signer_user_id: null,
    typed_name: sig.signer_name,
    ip_address: '',
    user_agent: '',
    ...sig,
  })) as ProposalSignature[];
  return { proposal, client, signatures };
}

function openContractDoc(slug: string) {
  const el = document.getElementById(`contract-${slug}`);
  if (!el) return;
  const details = el.querySelector('details');
  if (details) (details as HTMLDetailsElement).open = true;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Renders "the Proposal, the MSA and the SOW" with each contract as a link. */
function AgreedItems({ contracts }: { contracts: Array<{ slug: string; name: string }> }) {
  const parts: ReactNode[] = [
    <span key="proposal">the Proposal</span>,
    ...contracts.map(c => (
      <button
        key={c.slug}
        type="button"
        onClick={() => openContractDoc(c.slug)}
        className="font-semibold text-brand-primary underline decoration-brand-primary/40 underline-offset-2 hover:decoration-brand-primary"
      >
        {c.name}
      </button>
    )),
  ];
  return (
    <>
      {parts.map((node, i) => (
        <span key={i}>
          {i > 0 && (i === parts.length - 1 ? ' and ' : ', ')}
          {node}
        </span>
      ))}
    </>
  );
}

/** The real submit button, watched by the sticky bar so the two are never both
 *  on screen offering the same thing. */
const SIGN_BUTTON_ID = 'proposal-sign-button';

function ClientSignArea({
  recipientName,
  recipientEmail,
  contracts,
  onSign,
  signing,
  error,
}: {
  recipientName: string;
  recipientEmail: string;
  contracts: Array<{ slug: string; name: string }>;
  onSign: (typedName: string, email: string, signatureImage: string) => void;
  signing: boolean;
  error: string;
}) {
  const padRef = useRef<SignaturePadHandle>(null);
  const [typedName, setTypedName] = useState(recipientName);
  const [email, setEmail] = useState(recipientEmail);
  const [padEmpty, setPadEmpty] = useState(true);
  const [agreed, setAgreed] = useState(false);
  const [localError, setLocalError] = useState('');

  const submit = () => {
    setLocalError('');
    if (!typedName.trim()) {
      setLocalError('Please type your full name.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setLocalError('Please enter a valid email address.');
      return;
    }
    const image = padRef.current?.toDataURL();
    if (!image) {
      setLocalError('Please draw your signature.');
      return;
    }
    if (!agreed) {
      setLocalError('Please confirm you agree to the terms by checking the box above.');
      return;
    }
    onSign(typedName.trim(), email.trim(), image);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">Full name</label>
          <input
            type="text"
            value={typedName}
            onChange={e => setTypedName(e.target.value)}
            placeholder="Your full name"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-500">Email</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
          />
        </div>
      </div>
      <SignaturePad ref={padRef} onChange={setPadEmpty} typedName={typedName} />

      {/* Agreement to terms (clickwrap): conspicuous, links to every attached
          document, unchecked and required. */}
      <div className="rounded-xl border border-brand-primary/20 bg-brand-primary/[0.04] p-4">
        <p className="text-[11px] font-bold uppercase tracking-wide text-brand-primary">Agreement to contract terms</p>
        <label className="mt-2 flex cursor-pointer items-start gap-2.5">
          <BrandedCheckbox checked={agreed} onChange={setAgreed} aria-label="I have reviewed and agree to the terms" className="mt-0.5" />
          <span className="text-sm leading-relaxed text-gray-700">
            I have reviewed and agree to <AgreedItems contracts={contracts} />
            {contracts.length > 0 ? ', and any documents expressly incorporated into them.' : '.'}
          </span>
        </label>
      </div>

      {(localError || error) && (
        <p className="text-sm text-red-600">{localError || error}</p>
      )}
      <button
        type="button"
        id={SIGN_BUTTON_ID}
        disabled={signing || padEmpty || !agreed}
        onClick={submit}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg gradient-bg px-5 py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50 sm:w-auto"
      >
        <PenLine className="h-4 w-4" />
        {signing ? 'Signing…' : 'Accept & sign'}
      </button>
      <p className="text-[11px] leading-relaxed text-gray-400">
        Your name, email, IP address, and timestamp are recorded with your signature.
      </p>
    </div>
  );
}

export default function PublicProposal() {
  const { token } = useParams<{ token: string }>();
  const location = useLocation();
  const isPreview = new URLSearchParams(location.search).get('preview') === '1';

  const [payload, setPayload] = useState<PublicProposalPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState('');
  const [justSigned, setJustSigned] = useState(false);
  // Whether the real Accept and sign button is on screen. The sticky shortcut
  // exists to reach it from anywhere in a long proposal, so once the button is
  // visible the shortcut is a duplicate sitting beside it.
  //
  // Declared here with the rest of the state, ABOVE the loading and not-found
  // returns. A hook placed after an early return runs on some renders and not
  // others, which is React error #310 and took every proposal page down.
  const [signButtonInView, setSignButtonInView] = useState(false);
  // The optional lines the client has ticked (2026-10-30). Sent with the
  // signature; only the first client signer's choice is kept.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const togglePicked = useCallback((id: string) => {
    setPicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    if (!token) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    const data = await fetchPublicProposal(token, { preview: isPreview });
    if (!data) setNotFound(true);
    else setPayload(data);
    setLoading(false);
  }, [token, isPreview]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    let observer: IntersectionObserver | null = null;
    // One frame, so the commit that mounted the sign area has painted and the
    // button exists to be observed. canSign is computed further down the render,
    // so this cannot depend on it.
    const frame = requestAnimationFrame(() => {
      const el = document.getElementById(SIGN_BUTTON_ID);
      if (!el) {
        // No signable form on this render. Visible is the safe default: a
        // redundant shortcut beats no route to the signature form.
        setSignButtonInView(false);
        return;
      }
      observer = new IntersectionObserver(
        ([entry]) => setSignButtonInView(entry.isIntersecting),
        // A sliver counts, but not while it sits under the sticky bar itself.
        { threshold: 0.4, rootMargin: '0px 0px -96px 0px' },
      );
      observer.observe(el);
    });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
    // Re-run on any render that could mount or unmount the sign area.
  }, [payload, justSigned, signing]);

  const handleSign = async (typedName: string, email: string, signatureImage: string) => {
    if (!token) return;
    setSigning(true);
    setSignError('');
    const result = await signProposalPublic({
      token,
      typed_name: typedName,
      signer_email: email,
      signature_image: signatureImage,
      optional_line_ids: [...picked],
    });
    if (result.ok) {
      setJustSigned(true);
      await load();
    } else if (result.code === 'already_signed') {
      await load();
    } else if (result.code === 'expired') {
      setSignError('This proposal has expired. Please contact ECD to renew it.');
    } else {
      setSignError(result.message || 'Signing failed. Please try again.');
    }
    setSigning(false);
  };

  if (loading) return <AppPreloader />;

  if (notFound || !payload) {
    return (
      <FullScreenNotice
        icon={FileX2}
        title="Proposal not found"
        description="This link is invalid or the proposal is no longer available. Please check the link or contact ECD Digital Strategy."
      />
    );
  }

  const { proposal, client, signatures } = toDocumentModels(payload);
  // The contracts attached to this proposal, for the acceptance checkbox links.
  const includedContracts = (Array.isArray(proposal.contracts_snapshot) ? proposal.contracts_snapshot : [])
    .filter(c => proposal.include_contracts.includes(c.slug))
    .map(c => ({ slug: c.slug, name: c.name }));
  const settings = {
    ...DEFAULT_PROPOSAL_SETTINGS,
    ...mergeProposalSettings({ cover: payload.settings.cover }),
  };
  const isSigned = Boolean(payload.proposal.client_signed_at);
  // Which signer this link belongs to, and whether they personally signed already.
  const mySignerIndex = payload.signer_index ?? 1;
  const myIdentity = mySignerIndex === 2
    ? { name: payload.proposal.recipient2_name ?? '', email: payload.proposal.recipient2_email ?? '' }
    : { name: payload.proposal.recipient_name, email: payload.proposal.recipient_email ?? '' };
  const mySignature = payload.signatures.find(
    s => s.role === 'client' && (s.signer_index ?? 1) === mySignerIndex,
  ) ?? null;
  const otherSignerName = mySignerIndex === 2
    ? payload.proposal.recipient_name
    : payload.proposal.recipient2_name ?? '';
  const hasSecondSigner = Boolean(payload.proposal.recipient2_email);
  const waitingOnOther = Boolean(mySignature) && !isSigned && hasSecondSigner;
  const canSign = !isSigned && !mySignature && !payload.expired &&
    (payload.proposal.status === 'sent' || payload.proposal.status === 'viewed');

  if (payload.expired && !isSigned) {
    return (
      <FullScreenNotice
        icon={Clock}
        title="This proposal has expired"
        description="The acceptance window for this proposal has passed. Contact ECD Digital Strategy to receive an updated proposal."
      />
    );
  }

  // While nobody has chosen yet, this signer ticks the optional lines they want.
  const optionsOpen = canSign && !payload.line_items.some(li => li.optional && li.client_selected != null);
  const totals = computeProposalTotals(payload.line_items, proposalDiscountFromRow(proposal), optionsOpen ? picked : undefined);
  const totalParts: string[] = [];
  if (totals.oneTimeTotal > 0 || totals.oneTimeHasLabelOnly) {
    totalParts.push(formatProposalTotal(totals.oneTimeTotal, totals.oneTimeHasLabelOnly));
  }
  if (totals.monthlyTotal > 0) totalParts.push(`${formatProposalTotal(totals.monthlyTotal, false)}/mo`);

  const scrollToSignature = () => {
    document.getElementById('proposal-signatures')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="min-h-screen bg-[#f4f4f8] print:bg-white">
      <div className="mx-auto flex max-w-[880px] justify-end px-5 pt-6 sm:px-8 print:hidden">
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 shadow-sm hover:bg-gray-50"
        >
          <Download className="h-3.5 w-3.5" />
          Download PDF
        </button>
      </div>
      <main className="proposal-print-page mx-auto max-w-[880px] px-5 py-8 pb-32 sm:px-8 print:max-w-none print:px-0 print:py-0 print:pb-0">
        {(isSigned || justSigned || waitingOnOther) && (
          <div className="mb-6 flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 print:hidden">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            <div>
              <p className="text-sm font-semibold text-emerald-800">
                {waitingOnOther
                  ? 'Thank you! Your signature has been recorded.'
                  : justSigned
                  ? 'Thank you! This proposal has been signed.'
                  : 'This proposal has been signed.'}
              </p>
              <p className="mt-0.5 text-xs text-emerald-700">
                {waitingOnOther
                  ? `Waiting for ${otherSignerName || 'the other signer'} to sign before the agreement is complete.`
                  : payload.proposal.countersigned_at
                  ? 'Fully executed by both parties.'
                  : 'A countersigned copy will follow from ECD Digital Strategy.'}
              </p>
            </div>
          </div>
        )}

        <ProposalOptionsProvider value={{ picked: optionsOpen ? picked : new Set(), canChoose: optionsOpen, toggle: togglePicked }}>
        <ProposalEditProvider mode="public" proposal={proposal} lineItems={payload.line_items}>
          <ProposalDocument
            proposal={proposal}
            client={client}
            lineItems={payload.line_items}
            contractDocs={[]}
            signatures={signatures}
            settings={settings}
            collapsibleContracts
            liveSignerIndex={mySignerIndex}
            clientSignArea={
              canSign ? (
                <ClientSignArea
                  recipientName={myIdentity.name}
                  recipientEmail={myIdentity.email}
                  contracts={includedContracts}
                  onSign={handleSign}
                  signing={signing}
                  error={signError}
                />
              ) : undefined
            }
          />
        </ProposalEditProvider>
        </ProposalOptionsProvider>
      </main>

      {(canSign || justSigned) && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white/95 backdrop-blur print:hidden">
          <div className="mx-auto flex max-w-[880px] items-center justify-between gap-4 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-8">
            {justSigned ? (
              <div className="flex items-center gap-3">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-emerald-800">
                    {waitingOnOther ? 'Thank you! Your signature has been recorded.' : 'Thank you! This proposal has been signed.'}
                  </p>
                  <p className="text-xs text-emerald-700">
                    {waitingOnOther
                      ? `Waiting for ${otherSignerName || 'the other signer'} to sign.`
                      : 'A countersigned copy will follow from ECD Digital Strategy.'}
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Total</p>
                  <p className="truncate text-base font-bold tabular-nums text-gray-900">
                    {totalParts.join(' + ') || '—'}
                  </p>
                </div>
                {!signButtonInView && (
                  <button
                    type="button"
                    onClick={scrollToSignature}
                    className="inline-flex shrink-0 items-center gap-2 rounded-lg gradient-bg px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                  >
                    <PenLine className="h-4 w-4" />
                    Accept & sign
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
