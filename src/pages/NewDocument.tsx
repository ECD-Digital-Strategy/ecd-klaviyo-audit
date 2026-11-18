import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, FilePlus2, FileText, Upload } from 'lucide-react';
import TopBar from '../components/layout/TopBar';
import { createDocument, listDocumentTemplates } from '../lib/documents-db';
import { createPdfDocument, PDF_MAX_BYTES } from '../lib/pdf-docs';
import type { DocumentTemplate } from '../lib/types';

// The "Upload a PDF to sign" choice, alongside blank and the templates.
const PDF = '__pdf__';

export default function NewDocument() {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // template id or null (blank)
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listDocumentTemplates({ activeOnly: true }).then(setTemplates).catch(() => setTemplates([]));
  }, []);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setError('');
    try {
      // An uploaded PDF (2026-11-18): signed in place on its pages; fields are placed on the next screen.
      if (selected === PDF) {
        if (!pdfFile) throw new Error('Choose the PDF to upload first.');
        const doc = await createPdfDocument({ file: pdfFile, title: title.trim() || pdfFile.name.replace(/\.pdf$/i, '') });
        navigate(`/documents/${doc.id}`);
        return;
      }
      const template = selected ? templates.find(t => t.id === selected) ?? null : null;
      const doc = await createDocument({
        title: title.trim() || template?.name || 'Untitled document',
        content: template?.content ?? '',
        template_id: template?.id ?? null,
      });
      navigate(`/documents/${doc.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create document');
      setCreating(false);
    }
  };

  return (
    <div>
      <TopBar
        title="New Document"
        actions={
          <button onClick={() => navigate('/documents')} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
        }
      />
      <div className="mx-auto max-w-2xl p-8">
        <label className="block text-sm font-medium text-gray-700">Document title</label>
        <input
          autoFocus
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="e.g. Contractor NDA — Jane Doe"
          className="mt-1.5 w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
        />

        <p className="mt-6 text-sm font-medium text-gray-700">Start from</p>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            onClick={() => setSelected(null)}
            className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors ${selected === null ? 'border-brand-primary bg-brand-primary/5' : 'border-gray-200 hover:bg-gray-50'}`}
          >
            <FilePlus2 className="mt-0.5 h-5 w-5 shrink-0 text-brand-primary" />
            <div>
              <p className="text-sm font-semibold text-gray-900">Blank document</p>
              <p className="text-xs text-gray-500">Start from scratch or with the AI assistant.</p>
            </div>
          </button>
          <button
            onClick={() => { setSelected(PDF); fileRef.current?.click(); }}
            className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors ${selected === PDF ? 'border-brand-primary bg-brand-primary/5' : 'border-gray-200 hover:bg-gray-50'}`}
          >
            <Upload className="mt-0.5 h-5 w-5 shrink-0 text-brand-primary" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900">Upload a PDF to sign</p>
              <p className="truncate text-xs text-gray-500">{pdfFile ? pdfFile.name : 'Place signatures on any page, like DocuSign.'}</p>
            </div>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0] ?? null;
              if (f && f.size > PDF_MAX_BYTES) { setError('That PDF is over 25 MB.'); return; }
              setError('');
              setPdfFile(f);
              if (f) { setSelected(PDF); if (!title.trim()) setTitle(f.name.replace(/\.pdf$/i, '')); }
            }}
          />
          {templates.map(t => (
            <button
              key={t.id}
              onClick={() => setSelected(t.id)}
              className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors ${selected === t.id ? 'border-brand-primary bg-brand-primary/5' : 'border-gray-200 hover:bg-gray-50'}`}
            >
              <FileText className="mt-0.5 h-5 w-5 shrink-0 text-gray-400" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-gray-900">{t.name}</p>
                <p className="text-xs text-gray-500">Template</p>
              </div>
            </button>
          ))}
        </div>

        {error && <div className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}

        <div className="mt-6 flex justify-end">
          <button onClick={create} disabled={creating} className="rounded-lg bg-brand-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-primary-dark disabled:opacity-50">
            {creating ? (selected === PDF ? 'Uploading…' : 'Creating…') : selected === PDF ? 'Upload and place fields' : 'Create document'}
          </button>
        </div>
      </div>
    </div>
  );
}
