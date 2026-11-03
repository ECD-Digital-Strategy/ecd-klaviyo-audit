import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Copy, KeyRound } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { getGmailStatus, saveGoogleClient, type GmailStatus } from '../../lib/invoice-sending';

/**
 * Google sign-in for "Connect my Gmail" (invoice emails sent as a person): the
 * Google Cloud OAuth client id and secret. Admins only, in Settings, API
 * Connection with the other integrations (moved out of Proposal settings
 * 2026-11-03). Loads its own status.
 */
export default function GoogleSignInSetup() {
  const toast = useToast();
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => getGmailStatus().then(setStatus, () => setStatus(null)), []);
  useEffect(() => { void load(); }, [load]);

  const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label);
    try {
      await fn();
      await load();
      if (done) toast(done);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  if (!status?.is_admin) return null;
  return (
    <section className="overflow-hidden rounded-xl bg-white card-shadow">
      <div className="flex items-center gap-3 border-b border-gray-100 bg-gray-50/60 px-5 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-brand-primary">
          <KeyRound className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Google sign-in</h3>
          <p className="text-xs text-gray-500">Lets people connect their Gmail in Proposal settings to send invoice emails as themselves.</p>
        </div>
      </div>
      <GoogleClientSetup status={status} busy={busy} run={run} />
    </section>
  );
}

function GoogleClientSetup({
  status,
  busy,
  run,
}: {
  status: GmailStatus;
  busy: string | null;
  run: (label: string, fn: () => Promise<unknown>, done?: string) => Promise<void>;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(!status.configured);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  return (
    <div className="bg-gray-50/50 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-gray-900">
            Google sign-in
            {status.configured ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                <CheckCircle2 className="h-3 w-3" /> Set up
              </span>
            ) : (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">Not set up</span>
            )}
            <span className="text-[11px] font-normal text-gray-400">Admins only</span>
          </h4>
          <p className="mt-0.5 text-xs text-gray-500">
            {status.configured
              ? 'The Google app that "Connect my Gmail" signs in through.'
              : 'A Google Cloud OAuth client (Web application, Internal, Gmail API on) so people can connect their Gmail.'}
          </p>
          {status.configured && status.client_id_hint && (
            <p className="mt-1.5 font-mono text-[11px] text-gray-500">Client ID {status.client_id_hint}</p>
          )}
        </div>
        {status.configured && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="shrink-0 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
          >
            Replace credentials
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-4 space-y-3">
          <div>
            <p className="text-[11px] text-gray-500">Authorised redirect URI to add on the Google client:</p>
            <div className="mt-1 flex max-w-xl items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5">
              <code className="min-w-0 flex-1 truncate text-[11px] text-gray-700">{status.redirect_uri}</code>
              <button
                type="button"
                onClick={() => { void navigator.clipboard.writeText(status.redirect_uri); toast('Copied'); }}
                className="shrink-0 text-gray-400 hover:text-brand-primary"
                title="Copy"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <form
            className="grid max-w-xl gap-2 sm:grid-cols-2"
            onSubmit={e => {
              e.preventDefault();
              void run('client', async () => {
                await saveGoogleClient(clientId, clientSecret);
                setClientId('');
                setClientSecret('');
                setEditing(false);
              }, 'Google sign-in saved');
            }}
          >
            <input value={clientId} onChange={e => setClientId(e.target.value)} placeholder="Client ID" className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20" />
            <input value={clientSecret} onChange={e => setClientSecret(e.target.value)} type="password" autoComplete="off" placeholder="Client secret" className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-1 focus:ring-brand-primary/20" />
            <div className="flex items-center gap-3 sm:col-span-2">
              <button type="submit" disabled={busy !== null || !clientId.trim() || !clientSecret.trim()} className="rounded-lg gradient-bg px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
                {busy === 'client' ? 'Saving…' : 'Save credentials'}
              </button>
              {status.configured && (
                <button type="button" onClick={() => setEditing(false)} className="text-xs text-gray-500 hover:text-gray-800">Cancel</button>
              )}
              <span className="text-[11px] text-gray-400">Stored encrypted and never shown again.</span>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
