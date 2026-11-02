import { useEffect, useState } from 'react';
import { Image as ImageIcon, Mail } from 'lucide-react';
import ImageUploadZone from '../ui/ImageUploadZone';
import { useToast } from '../ui/Toast';
import { getProposalSettings, updateProposalSettings } from '../../lib/proposals-db';
import { uploadReportScreenshot } from '../../lib/db';
import type { ProposalSettings } from '../../lib/types';
import VoiceProfileSection from '../ui/VoiceProfileSection';
import InvoiceEmailSettings from './InvoiceEmailSettings';
import SettingsCard from '../ui/SettingsCard';

export default function ProposalSettingsPanel() {
  const toast = useToast();
  const [settings, setSettings] = useState<ProposalSettings | null>(null);
  const [teamEmailsRaw, setTeamEmailsRaw] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<'logo' | 'background' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    getProposalSettings()
      .then(s => {
        setSettings(s);
        setTeamEmailsRaw(s.email.team_notification_emails.join(', '));
      })
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load settings'));
  }, []);

  if (!settings) {
    return <div className="h-64 animate-pulse rounded-xl bg-white card-shadow" />;
  }

  const patch = (updates: Partial<ProposalSettings>) =>
    setSettings(prev => (prev ? { ...prev, ...updates } : prev));

  const uploadCoverImage = async (kind: 'logo' | 'background', file: File) => {
    setUploading(kind);
    setError('');
    try {
      const url = await uploadReportScreenshot(file, 'proposal-cover');
      patch({
        cover: { ...settings.cover, [kind === 'logo' ? 'logo_url' : 'background_url']: url },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(null);
    }
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const teamEmails = teamEmailsRaw
        .split(/[,;\s]+/)
        .map(s => s.trim())
        .filter(s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
      await updateProposalSettings({
        ...settings,
        email: { ...settings.email, team_notification_emails: teamEmails },
        defaults: {
          valid_days: Math.max(1, Math.round(Number(settings.defaults.valid_days) || 30)),
        },
      });
      setTeamEmailsRaw(teamEmails.join(', '));
      toast('Proposal settings saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full max-w-md rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20';

  return (
    <div className="space-y-4 animate-slide-up">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Proposal Settings</h2>
          <p className="mt-0.5 text-sm text-gray-500">
            Invoice emails, the AI's voice, sending defaults and the cover page. Click a section to open it.
          </p>
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

      <InvoiceEmailSettings value={settings.invoicing} onChange={v => patch({ invoicing: v })} inputClass={inputClass} />

      <VoiceProfileSection
        domain="proposal"
        collapsible
        value={settings.voice_profile ?? ''}
        onChange={v => patch({ voice_profile: v })}
      />

      <SettingsCard
        icon={<Mail className="h-4 w-4" />}
        title="Email & defaults"
        description="Who proposal emails come from, who hears about views and signatures, and how long a proposal stays open."
        collapsible
        defaultOpen={false}
        storageKey="settings_open_proposal_email"
      >
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
            <label className="mb-1 block text-xs font-medium text-gray-500">Proposal valid for (days)</label>
            <input
              type="number"
              min={1}
              value={settings.defaults.valid_days}
              onChange={e =>
                patch({ defaults: { valid_days: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 } })
              }
              className={inputClass}
            />
            {/* The rule, written down, because it was previously only implied by
                the code: one global window, started by the client's first view. */}
            <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">
              Applies to every proposal. The countdown starts when the client first opens it, not when you send the
              link, and runs to the end of that day. Proposals that reach the date are marked lost automatically. You
              can override the date on an individual proposal from its page.
            </p>
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
      </SettingsCard>

      <SettingsCard
        icon={<ImageIcon className="h-4 w-4" />}
        title="Cover page"
        description="The tagline, logo and background at the top of every proposal."
        collapsible
        defaultOpen={false}
        storageKey="settings_open_proposal_cover"
      >
        <div className="space-y-4 p-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Tagline</label>
            <input
              type="text"
              value={settings.cover.tagline ?? ''}
              onChange={e => patch({ cover: { ...settings.cover, tagline: e.target.value || null } })}
              placeholder="Lifecycle marketing that compounds."
              className={inputClass}
            />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Logo (optional)</label>
              <ImageUploadZone
                compact
                previewUrl={settings.cover.logo_url}
                previewAlt="Proposal cover logo"
                label="Add logo"
                hint="Click, then paste with Ctrl+V, or drag & drop"
                uploading={uploading === 'logo'}
                onFile={file => uploadCoverImage('logo', file)}
                onRemove={
                  settings.cover.logo_url
                    ? () => patch({ cover: { ...settings.cover, logo_url: null } })
                    : undefined
                }
              />
              <p className="mt-1 text-[11px] text-gray-400">Replaces the default ECD brand mark.</p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Background image (optional)</label>
              <ImageUploadZone
                compact
                previewUrl={settings.cover.background_url}
                previewAlt="Proposal cover background"
                label="Add background"
                hint="Click, then paste with Ctrl+V, or drag & drop"
                uploading={uploading === 'background'}
                onFile={file => uploadCoverImage('background', file)}
                onRemove={
                  settings.cover.background_url
                    ? () => patch({ cover: { ...settings.cover, background_url: null } })
                    : undefined
                }
              />
              <p className="mt-1 text-[11px] text-gray-400">Blended over the purple gradient.</p>
            </div>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
