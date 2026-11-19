import { useState } from 'react';
import { BookOpen, ChevronDown, Plus, Trash2 } from 'lucide-react';
import SettingsCard from '../ui/SettingsCard';
import ToggleSwitch from '../ui/ToggleSwitch';
import { cn } from '../../lib/utils';
import type { ProposalKnowledgeEntry } from '../../lib/types';

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `k${Date.now()}`);

/**
 * Agency Knowledge (Xiomara, 2026-11-19): ECD's current rules for a service, which the proposal AI follows whenever a
 * proposal includes it (supabase/functions/_shared/proposal-knowledge.ts). Short rules work best; the client-facing
 * reference is optional wording to borrow from. Never paste an internal-only version: the AI writes for clients.
 */
export default function KnowledgeSettings({
  value,
  onChange,
  inputClass,
}: {
  value: ProposalKnowledgeEntry[];
  onChange: (next: ProposalKnowledgeEntry[]) => void;
  inputClass: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const update = (id: string, patch: Partial<ProposalKnowledgeEntry>) =>
    onChange(value.map(e => (e.id === id ? { ...e, ...patch, updated_at: new Date().toISOString() } : e)));
  const add = () => {
    const entry: ProposalKnowledgeEntry = { id: newId(), title: '', applies_when: '', rules: '', reference: '', enabled: true, updated_at: new Date().toISOString() };
    onChange([...value, entry]);
    setOpen(entry.id);
  };
  const on = value.filter(e => e.enabled).length;

  return (
    <SettingsCard
      icon={<BookOpen className="h-4 w-4" />}
      title="Knowledge"
      description="ECD's current rules for specific services (for example email warmup). The proposal AI follows them in any proposal that includes that service, ahead of templates and older proposals."
      badge={value.length ? <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">{on} on</span> : undefined}
      collapsible
      defaultOpen={false}
      storageKey="settings_open_proposal_knowledge"
    >
      <div className="space-y-3 p-5">
        {value.length === 0 && <p className="text-sm text-gray-500">No entries yet.</p>}
        {value.map(e => {
          const isOpen = open === e.id;
          return (
            <div key={e.id} className="rounded-lg border border-gray-200">
              <div className="flex items-center gap-2 px-3 py-2.5">
                <button type="button" onClick={() => setOpen(isOpen ? null : e.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <ChevronDown className={cn('h-4 w-4 shrink-0 text-gray-400 transition-transform', !isOpen && '-rotate-90')} />
                  <span className={cn('truncate text-sm font-medium', e.enabled ? 'text-gray-900' : 'text-gray-400')}>{e.title || 'Untitled entry'}</span>
                  {e.updated_at && <span className="shrink-0 text-[11px] text-gray-400">updated {new Date(e.updated_at).toLocaleDateString()}</span>}
                </button>
                <ToggleSwitch checked={e.enabled} onChange={v => update(e.id, { enabled: v })} aria-label={e.enabled ? 'Turn off' : 'Turn on'} />
                <button
                  type="button"
                  onClick={() => { if (window.confirm(`Remove "${e.title || 'this entry'}"?`)) onChange(value.filter(x => x.id !== e.id)); }}
                  className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove entry"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {isOpen && (
                <div className="space-y-3 border-t border-gray-100 p-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-500">Title</label>
                    <input value={e.title} onChange={ev => update(e.id, { title: ev.target.value })} placeholder="Email warmup" className={inputClass} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-500">Applies when</label>
                    <input value={e.applies_when} onChange={ev => update(e.id, { applies_when: ev.target.value })} placeholder="Any proposal that includes an email or domain warmup" className={cn(inputClass, 'max-w-none')} />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-500">Rules the AI must follow</label>
                    <textarea value={e.rules} onChange={ev => update(e.id, { rules: ev.target.value })} rows={12} placeholder="Scope, limits, prices, what's excluded, client obligations, no guarantees." className="w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs leading-relaxed focus:border-brand-primary focus:outline-none" />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-500">Client-facing reference wording (optional)</label>
                    <textarea value={e.reference ?? ''} onChange={ev => update(e.id, { reference: ev.target.value })} rows={8} placeholder="The client version of the process, for the AI to borrow wording from. Never the internal version." className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs leading-relaxed focus:border-brand-primary focus:outline-none" />
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <button type="button" onClick={add} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50">
          <Plus className="h-4 w-4" /> Add an entry
        </button>
        <p className="text-xs text-gray-400">Changes apply to the next proposal the AI writes, after you save the settings.</p>
      </div>
    </SettingsCard>
  );
}
