import { useState } from 'react';
import { Sparkles, Wand2 } from 'lucide-react';
import { useToast } from './Toast';
import SettingsCard from './SettingsCard';
import { generateVoiceProfile } from '../../lib/proposals-db';

/** Editable "house voice & style" guide the AI applies to every draft, with an
 * option to draft it from recent work. Shared by the proposal and document
 * settings panels. */
export default function VoiceProfileSection({
  domain,
  value,
  onChange,
  collapsible = false,
}: {
  domain: 'proposal' | 'document';
  value: string;
  onChange: (next: string) => void;
  /** Fold to its header (Proposal settings). */
  collapsible?: boolean;
}) {
  const toast = useToast();
  const [generating, setGenerating] = useState(false);

  const noun = domain === 'proposal' ? 'proposals' : 'documents';

  const generate = async () => {
    setGenerating(true);
    try {
      const profile = await generateVoiceProfile(domain);
      if (profile.trim()) {
        onChange(profile.trim());
        toast('Drafted a voice profile from your recent work. Review, tweak, then Save.');
      } else {
        toast(`Not enough past ${noun} yet to draft a voice profile. Write one, or come back later.`);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not generate a voice profile');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <SettingsCard
      icon={<Sparkles className="h-4 w-4" />}
      title="Voice & style"
      description={`How the AI assistant should write. Applied to every ${domain} it drafts.`}
      collapsible={collapsible}
      defaultOpen={false}
      storageKey={`settings_open_${domain}_voice`}
      action={
        <button
          type="button"
          onClick={generate}
          disabled={generating}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <Wand2 className="h-3.5 w-3.5" />
          {generating ? 'Generating…' : 'Generate from past work'}
        </button>
      }
    >
      <div className="p-5">
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={8}
          placeholder={`Describe your house voice: tone, sentence length, formatting habits, words you love or avoid, how you open and close. Or click "Generate from past work" to draft it from your recent ${noun}.`}
          className="w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-sm leading-relaxed focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20"
        />
        <p className="mt-1 text-[11px] text-gray-400">Leave blank to use the assistant's default professional voice.</p>
      </div>
    </SettingsCard>
  );
}
