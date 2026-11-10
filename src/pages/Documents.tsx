import { useEffect, useMemo, useState } from 'react';
import { rowNavProps } from '../lib/row-nav';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FileText, LayoutTemplate, Plus, Settings2, Trash2 } from 'lucide-react';
import TopBar from '../components/layout/TopBar';
import Modal from '../components/ui/Modal';
import { SkeletonTable } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import DocumentTemplatesPanel from '../components/document/DocumentTemplatesPanel';
import DocumentSettingsPanel from '../components/document/DocumentSettingsPanel';
import { DocumentAgentProvider } from '../components/document/agent/DocumentAgentContext';
import { DocumentAgentLayout, DocAgentToggleButton } from '../components/document/agent/DocumentAgentLayout';
import { deleteDocument, listDocuments } from '../lib/documents-db';
import { applyDraftAsNewDocument, type DocDraftPayload } from '../lib/document-agent';
import { linkDocConversationToDocument } from '../lib/document-agent-db';
import { isPastValidUntil } from '../lib/valid-until';
import type { Document, DocumentDisplayStatus } from '../lib/types';

const TABS = [
  { id: 'overview', label: 'Documents', icon: FileText },
  { id: 'templates', label: 'Templates', icon: LayoutTemplate },
  { id: 'settings', label: 'Settings', icon: Settings2 },
] as const;

type TabId = (typeof TABS)[number]['id'];

const STATUS_LABELS: Record<DocumentDisplayStatus, { label: string; tone: string }> = {
  draft: { label: 'Draft', tone: 'bg-gray-100 text-gray-600' },
  sent: { label: 'Sent', tone: 'bg-blue-50 text-blue-600' },
  viewed: { label: 'Viewed', tone: 'bg-purple-50 text-purple-600' },
  signed: { label: 'Signed', tone: 'bg-emerald-50 text-emerald-600' },
  void: { label: 'Void', tone: 'bg-red-50 text-red-600' },
  expired: { label: 'Expired', tone: 'bg-amber-50 text-amber-700' },
};

function displayStatus(doc: Document): DocumentDisplayStatus {
  // Same New York clock as the public link (valid-until.ts).
  if ((doc.status === 'sent' || doc.status === 'viewed') && isPastValidUntil(doc.valid_until)) return 'expired';
  return doc.status;
}

function DocumentList({
  documents,
  onDeleted,
  emptyAction,
}: {
  documents: Document[];
  onDeleted: (id: string) => void;
  emptyAction: React.ReactNode;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const [deleteTarget, setDeleteTarget] = useState<Document | null>(null);

  const remove = async () => {
    if (!deleteTarget) return;
    try {
      await deleteDocument(deleteTarget.id);
      onDeleted(deleteTarget.id);
      toast('Document deleted');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete document');
    } finally {
      setDeleteTarget(null);
    }
  };

  if (documents.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-200 bg-white p-12 text-center">
        <FileText className="mx-auto h-9 w-9 text-gray-300" />
        <p className="mt-3 text-sm text-gray-500">No documents yet. Create one to send for signature.</p>
        <div className="mt-5 flex justify-center">{emptyAction}</div>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl bg-white card-shadow">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wide text-gray-400">
            <th className="px-5 py-3">Document</th>
            <th className="px-5 py-3">Recipient</th>
            <th className="px-5 py-3">Status</th>
            <th className="px-5 py-3">Updated</th>
            <th className="px-5 py-3" />
          </tr>
        </thead>
        <tbody>
          {documents.map(doc => {
            const status = displayStatus(doc);
            return (
              <tr
                key={doc.id}
                {...rowNavProps(`/documents/${doc.id}`, navigate)}
                className="cursor-pointer border-b border-gray-50 last:border-0 hover:bg-gray-50/60"
              >
                <td className="px-5 py-3.5">
                  <div className="font-medium text-gray-900">{doc.title || 'Untitled document'}</div>
                  <div className="text-xs text-gray-400">DOC-{String(doc.document_number).padStart(4, '0')}</div>
                </td>
                <td className="px-5 py-3.5 text-gray-600">
                  {doc.recipient_name || doc.recipient_email || <span className="text-gray-300">Not set</span>}
                </td>
                <td className="px-5 py-3.5">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_LABELS[status].tone}`}>
                    {STATUS_LABELS[status].label}
                  </span>
                </td>
                <td className="px-5 py-3.5 text-gray-500">{new Date(doc.updated_at).toLocaleDateString()}</td>
                <td className="px-5 py-3.5 text-right">
                  <button
                    onClick={e => { e.stopPropagation(); setDeleteTarget(doc); }}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
                    aria-label="Delete document"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <Modal open={!!deleteTarget} title="Delete document?" onClose={() => setDeleteTarget(null)} className="max-w-md">
        <div className="p-5">
          <p className="text-sm text-gray-700">Permanently delete "{deleteTarget?.title || 'Untitled document'}"? This cannot be undone.</p>
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => setDeleteTarget(null)} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
            <button onClick={remove} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700">Delete</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default function Documents() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: TabId = TABS.some(t => t.id === tabParam) ? (tabParam as TabId) : 'overview';

  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError('');
        const data = await listDocuments();
        if (!cancelled) setDocuments(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load documents');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const newButton = useMemo(
    () => (
      <button
        onClick={() => navigate('/documents/new')}
        className="flex items-center gap-2 rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90"
      >
        <Plus className="h-4 w-4" /> New Document
      </button>
    ),
    [navigate],
  );

  const onApplyDraft = async (draft: DocDraftPayload, conversationId: string) => {
    const doc = await applyDraftAsNewDocument(draft);
    if (conversationId) await linkDocConversationToDocument(conversationId, doc.id).catch(() => {});
    navigate(`/documents/${doc.id}`);
  };

  return (
    <DocumentAgentProvider config={{ documentId: null, onApplyDraft }}>
      <DocumentAgentLayout>
        <div>
          <TopBar
            title="Documents"
            subtitle={`${documents.length} total`}
            actions={
              <div className="flex items-center gap-3">
                {newButton}
                <DocAgentToggleButton className="px-4 py-2 text-sm" />
              </div>
            }
          />

          <div className="p-8 animate-fade-in">
            <div className="mb-6 flex gap-2 border-b border-gray-100 pb-3">
              {TABS.map(t => (
                <button
                  key={t.id}
                  onClick={() => setSearchParams(t.id === 'overview' ? {} : { tab: t.id }, { replace: true })}
                  className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                    tab === t.id ? 'bg-brand-primary/10 text-brand-primary' : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
                  }`}
                >
                  <t.icon className="h-4 w-4" />
                  {t.label}
                </button>
              ))}
            </div>

            {tab === 'overview' && (
              <>
                {error && <div className="mb-6 rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-600">{error}</div>}
                {loading ? (
                  <SkeletonTable rows={5} cols={5} />
                ) : (
                  <DocumentList
                    documents={documents}
                    onDeleted={id => setDocuments(prev => prev.filter(d => d.id !== id))}
                    emptyAction={newButton}
                  />
                )}
              </>
            )}
            {tab === 'templates' && <DocumentTemplatesPanel />}
            {tab === 'settings' && <DocumentSettingsPanel />}
          </div>
        </div>
      </DocumentAgentLayout>
    </DocumentAgentProvider>
  );
}
