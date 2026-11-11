import { useEffect, useState } from 'react';
import { CalendarClock, Info, Link2, PartyPopper } from 'lucide-react';
import SettingsCard from '../ui/SettingsCard';
import ToggleSwitch, { ToggleRow } from '../ui/ToggleSwitch';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/select';
import { TemplateEditor } from './InvoiceEmailSettings';
import { getGmailStatus } from '../../lib/invoice-sending';
import type { WelcomeSettings } from '../../lib/types';

// Proposal settings: the welcome email after signing (Xiomara 2026-11-03, Emil
// 2026-11-04). One email from the sender's Gmail with the invoice, launch call
// times that fit Isa's and the LS's (Lifecycle Strategist's) calendars, the ECD onboarding form, the W-9
// and the client's intake form. Existing clients get the invoice and their intake
// form. Off until switched on; saved with the panel's Save settings. Server side:
// supabase/functions/_shared/welcome-delivery.ts.

const PLACEHOLDERS = [
  'first_name',
  'company',
  'proposal_title',
  'total',
  'due_date',
  'pay_link',
  'invoice_number',
  'ecd_onboarding_form',
  'client_onboarding_form',
  'w9_link',
  'launch_call_times',
  'intro',
  'sender_first_name',
] as const;

const ZONES = [
  { value: 'America/New_York', label: 'Eastern (ET)' },
  { value: 'America/Chicago', label: 'Central (CT)' },
  { value: 'America/Denver', label: 'Mountain (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific (PT)' },
  { value: 'Europe/London', label: 'London' },
];

const parseEmails = (raw: string) =>
  raw.split(/[,;\s]+/).map(e => e.trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

const numberClass =
  'w-16 rounded-lg border border-gray-200 px-2 py-1 text-center text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20';
const timeClass =
  'rounded-lg border border-gray-200 px-2 py-1 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20';

export default function WelcomeEmailSettings({
  value,
  onChange,
  inputClass,
}: {
  value: WelcomeSettings;
  onChange: (next: WelcomeSettings) => void;
  inputClass: string;
}) {
  const [canTest, setCanTest] = useState(false);
  const [calRaw, setCalRaw] = useState(value.call_attendee_emails.join(', '));
  const calJoined = value.call_attendee_emails.join(', ');
  useEffect(() => { setCalRaw(calJoined); }, [calJoined]);
  useEffect(() => {
    getGmailStatus().then(s => setCanTest(Boolean(s.mine)), () => setCanTest(false));
  }, []);

  const set = (patch: Partial<WelcomeSettings>) => onChange({ ...value, ...patch });
  const wide = inputClass.replace('max-w-md', 'max-w-3xl');
  const num = (v: string, fallback: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v)) || fallback));

  return (
    <SettingsCard
      icon={<PartyPopper className="h-4 w-4" />}
      title="Welcome email"
      description="Replaces the invoice email after signing, drafted in the sender's Gmail for them to send. A new client's has the invoice, launch call times that fit the team's calendars, the onboarding form, the W-9 and their intake form. An existing client's has the invoice and the intake form for what they bought."
      control={
        <>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${value.enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
            {value.enabled ? 'On' : 'Off'}
          </span>
          <ToggleSwitch
            checked={value.enabled}
            // From the moment it goes on: switching it on never emails clients who signed before.
            onChange={v => set({ enabled: v, since: v ? new Date().toISOString() : value.since })}
            aria-label="Send the welcome email after signing"
          />
        </>
      }
      collapsible
      defaultOpen={false}
      storageKey="settings_open_proposal_welcome"
    >
      <div className="divide-y divide-gray-100">
        {/* 1. How it goes out */}
        <div className="space-y-4 p-5">
          <div>
            <h4 className="text-sm font-semibold text-gray-900">How it goes out</h4>
            <p className="mt-0.5 text-xs text-gray-500">
              In the same Gmail as the invoice email (the proposal&apos;s creator, else the fallback sender), with the invoice PDF and
              the Always copy list from Invoice emails.
            </p>
          </div>
          <div className="rounded-lg border border-gray-100 bg-gray-50/60 p-3 text-xs leading-relaxed text-gray-600">
            <p className="font-semibold text-gray-800">Never sent automatically</p>
            <p className="mt-0.5">
              It&apos;s written as a draft in the sender&apos;s own Gmail, and they get a Slack message with a link that opens it, plus
              anything to check (no free launch call time, no intake form, a custom deal). They read it, change what they like and press
              Send.
            </p>
          </div>
          <p className="flex items-start gap-1.5 text-[11px] text-gray-500">
            <Info className="mt-0.5 h-3 w-3 shrink-0 text-gray-400" />
            If it can&apos;t go into Gmail (their Gmail isn&apos;t connected or needs reconnecting), it waits on the proposal page and they
            are told how to fix it.
          </p>
          <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
            Wait up to
            <input type="number" min={0} max={168} value={value.wait_hours} onChange={e => set({ wait_hours: num(e.target.value, 24, 0, 168) })} className={numberClass} />
            hours after signing for the LS to be confirmed and the intake form to be made.
          </div>
        </div>

        {/* 2. Links */}
        <div className="space-y-4 p-5">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
            <Link2 className="h-4 w-4 text-gray-400" /> Links for new clients
          </h4>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">ECD onboarding form</label>
            <input type="url" value={value.ecd_onboarding_form_url} onChange={e => set({ ecd_onboarding_form_url: e.target.value.trim() })} className={wide} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">W-9</label>
            <input type="url" value={value.w9_url} onChange={e => set({ w9_url: e.target.value.trim() })} className={wide} />
          </div>
          <p className="text-[11px] text-gray-400">
            The client&apos;s intake form comes from the Client Tracker: it&apos;s made when they sign, with the tabs for what they bought.
          </p>
        </div>

        {/* 3. Launch call */}
        <div className="space-y-4 p-5">
          <div>
            <h4 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
              <CalendarClock className="h-4 w-4 text-gray-400" /> Launch call times (new clients)
            </h4>
            <p className="mt-0.5 text-xs text-gray-500">
              Times everyone below is free, read from Google Calendar free/busy (never what the events are). One per day, morning and
              afternoon in turn.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Calendars to check</label>
            <input
              type="text"
              value={calRaw}
              onChange={e => setCalRaw(e.target.value)}
              onBlur={() => {
                const list = parseEmails(calRaw);
                setCalRaw(list.join(', '));
                set({ call_attendee_emails: list });
              }}
              placeholder="isa@ecdigitalstrategy.com"
              className={wide}
            />
          </div>
          <ToggleRow
            title="Also the client's LS"
            description="The client's Lifecycle Strategist (LS) from the Client Tracker, once the pod is confirmed."
            checked={value.call_include_rs}
            onChange={v => set({ call_include_rs: v })}
          />
          <ToggleRow
            title="Also whoever sends it"
            description="The sender's own calendar (Xiomara, or the proposal's creator), so they can join the call too."
            checked={value.call_include_sender}
            onChange={v => set({ call_include_sender: v })}
          />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm text-gray-600">
            Offer
            <input type="number" min={1} max={6} value={value.call_count} onChange={e => set({ call_count: num(e.target.value, 3, 1, 6) })} className={numberClass} />
            times of
            <input type="number" min={15} max={180} step={15} value={value.call_minutes} onChange={e => set({ call_minutes: num(e.target.value, 45, 15, 180) })} className={numberClass} />
            minutes, between
            <input type="time" value={value.call_day_start} onChange={e => set({ call_day_start: e.target.value || '10:00' })} className={timeClass} />
            and
            <input type="time" value={value.call_day_end} onChange={e => set({ call_day_end: e.target.value || '16:00' })} className={timeClass} />
            <Select value={value.call_timezone} onValueChange={v => set({ call_timezone: v })}>
              <SelectTrigger className="h-8 w-40 bg-white text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ZONES.map(z => (
                  <SelectItem key={z.value} value={z.value}><SelectItemText>{z.label}</SelectItemText></SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
            From
            <input
              type="number"
              min={1}
              max={20}
              value={value.call_first_day}
              onChange={e => {
                const first = num(e.target.value, 2, 1, 20);
                set({ call_first_day: first, call_last_day: Math.max(first, value.call_last_day) });
              }}
              className={numberClass}
            />
            to
            <input
              type="number"
              min={1}
              max={30}
              value={value.call_last_day}
              onChange={e => set({ call_last_day: Math.max(value.call_first_day, num(e.target.value, 10, 1, 30)) })}
              className={numberClass}
            />
            business days after the email goes.
          </div>
        </div>

        {/* 4. The emails */}
        <div className="space-y-4 p-5">
          <TemplateEditor
            tabs={[
              { key: 'welcome_new', label: 'New client', hint: 'A client signing with us for the first time.', subject: value.new_subject, body: value.new_body, onSubject: v => set({ new_subject: v }), onBody: v => set({ new_body: v }) },
              { key: 'welcome_project', label: 'Existing client', hint: 'A client we already work with, signing more work.', subject: value.project_subject, body: value.project_body, onSubject: v => set({ project_subject: v }), onBody: v => set({ project_body: v }) },
            ]}
            inputClass={wide}
            canTest={canTest}
            testDisabledReason="Connect your Gmail under Invoice emails to send yourself a test"
            placeholders={PLACEHOLDERS}
            note="A line whose placeholder has nothing to fill (no invoice, no intake form, no free times) is left out, so the email reads naturally whatever is missing. {launch_call_times} becomes one line per time."
          />
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">{'{intro}'}: when it comes from the fallback sender</label>
            <input type="text" value={value.intro_line} onChange={e => set({ intro_line: e.target.value })} className={wide} />
            <p className="mt-1 text-[11px] text-gray-400">Left out when the email comes from the proposal&apos;s creator, who the client already knows.</p>
          </div>
        </div>
      </div>
    </SettingsCard>
  );
}
