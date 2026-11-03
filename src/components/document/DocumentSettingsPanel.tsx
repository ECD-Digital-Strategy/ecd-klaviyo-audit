import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { getDocumentSettings, updateDocumentSettings } from '../../lib/documents-db';
import VoiceProfileSection from '../ui/VoiceProfileSection';
import UnsavedChangesBar from '../ui/UnsavedChangesBar';
import type { DocumentSettings } from '../../lib/types';

export default function DocumentSettingsPanel() {
  const toast = useToast();
  const [settings, setSettings] = useState<DocumentSettings | null>(null);
  const [teamEmailsRaw, setTeamEmailsRaw] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // What was last loaded or saved, to know when something changed (and to Discard).
  const [saved, setSaved] = useState<{ settings: DocumentSettings; teamEmailsRaw: string } | null>(null);

  useEffect(() => {
    getDocumentSettings()
      .then(s => {
        setSettings(s);
        setTeamEmailsRaw(s.email.team_notification_emails.join(', '));
        setSaved({ settings: s, teamEmailsRaw: s.email.team_notification_emails.join(', ') });
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load settings'));
  }, []);

  if (!settings) {
    return <div className="h-64 animate-pulse rounded-xl bg-white card-shadow" />;
  }

  const patch = (updates: Partial<DocumentSettings>) =>
    setSettings(prev => (prev ? { ...prev, ...updates } : prev));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const teamEmails = teamEmailsRaw
        .split(/[,;\s]+/)
        .map(s => s.trim())
        .filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
      const next: DocumentSettings = {
        ...settings,
        email: { ...settings.email, team_notification_emails: teamEmails },
        defaults: {
          valid_days: Math.max(0, Math.round(Number(settings.defaults.valid_days) || 0)),
        },
      };
      await updateDocumentSettings(next);
      setSettings(next);
      setTeamEmailsRaw(teamEmails.join(', '));
      setSaved({ settings: next, teamEmailsRaw: teamEmails.join(', ') });
      toast('Document settings saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    saved !== null &&
    (JSON.stringify(settings) !== JSON.stringify(saved.settings) || teamEmailsRaw !== saved.teamEmailsRaw);
  const discard = () => {
    if (!saved) return;
    setSettings(saved.settings);
    setTeamEmailsRaw(saved.teamEmailsRaw);
    setError('');
  };

  const inputClass =
    'w-full max-w-md rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20';

  return (
    <div className="space-y-4 animate-slide-up">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Document Settings</h2>
          <p className="mt-0.5 text-sm text-gray-500">Sending identity and defaults used by every document.</p>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="shrink-0 rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>

      {error && <div className="rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-600">{error}</div>}

      <UnsavedChangesBar show={dirty} saving={saving} onSave={() => void save()} onDiscard={discard} />

      <section className="rounded-xl bg-white card-shadow overflow-hidden">
        <div className="flex items-center gap-3 border-b border-gray-100 bg-gray-50/60 px-5 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-brand-primary">
            <Mail className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-900">Email & defaults</h3>
            <p className="text-xs text-gray-500">
              Sent through the mail server configured on the backend. Until that&apos;s set up, sending falls back to copy-link.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">From name</label>
            <input
              type="text"
              value={settings.email.from_name ?? ''}
              onChange={e => patch({ email: { ...settings.email, from_name: e.target.value || null } })}
              placeholder="ECD Digital Strategy"
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">From email</label>
            <input
              type="email"
              value={settings.email.from_email ?? ''}
              onChange={e => patch({ email: { ...settings.email, from_email: e.target.value || null } })}
              placeholder="hello@ecdigitalstrategy.com"
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-gray-400">Leave blank to send from the configured mail account.</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Reply-to (optional)</label>
            <input
              type="email"
              value={settings.email.reply_to ?? ''}
              onChange={e => patch({ email: { ...settings.email, reply_to: e.target.value || null } })}
              placeholder="emil@ecdigitalstrategy.com"
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Signing link valid for (days)</label>
            <input
              type="number"
              min={0}
              value={settings.defaults.valid_days}
              onChange={e => patch({ defaults: { valid_days: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 } })}
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-gray-400">0 means the link never expires.</p>
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium text-gray-500">
              Team notifications (on first view and signature)
            </label>
            <input
              type="text"
              value={teamEmailsRaw}
              onChange={e => setTeamEmailsRaw(e.target.value)}
              placeholder="emil@ecdigitalstrategy.com"
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-gray-400">Comma-separated email addresses.</p>
          </div>
        </div>
      </section>

      <VoiceProfileSection
        domain="document"
        value={settings.voice_profile ?? ''}
        onChange={v => patch({ voice_profile: v })}
      />
    </div>
  );
}
