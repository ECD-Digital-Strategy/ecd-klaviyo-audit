import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, ExternalLink, Link2, Loader2, RefreshCw, Unlink } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/select';
import { useToast } from '../ui/Toast';
import XeroServiceAccountsEditor from './XeroServiceAccountsEditor';
import {
  disconnectXero,
  getXeroStatus,
  listXeroRevenueAccounts,
  saveXeroSettings,
  startXeroConnect,
  type XeroAccount,
  type XeroStatus,
} from '../../lib/xero';

/** Connect the agency's Xero org and choose where signed proposals post to. */
export default function XeroSettingsPanel() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<XeroStatus | null>(null);
  const [accounts, setAccounts] = useState<XeroAccount[]>([]);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | 'save' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setError('');
    try {
      const s = await getXeroStatus();
      setStatus(s);
      if (s.connected) {
        // Best effort: the account picker is a convenience, and a Xero hiccup
        // here should not make the panel look broken.
        listXeroRevenueAccounts().then(setAccounts).catch(() => {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the Xero status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // Surface the outcome of the OAuth round trip, then clean the URL so a
  // refresh does not repeat the toast.
  useEffect(() => {
    const outcome = params.get('xero');
    if (!outcome) return;
    if (outcome === 'connected') toast(`Connected to Xero${params.get('xero_org') ? `: ${params.get('xero_org')}` : ''}`);
    else toast(params.get('xero_detail') || 'Could not connect to Xero');
    const next = new URLSearchParams(params);
    ['xero', 'xero_detail', 'xero_org'].forEach(k => next.delete(k));
    setParams(next, { replace: true });
    void reload();
  }, [params, setParams, toast, reload]);

  const connect = async () => {
    setBusy('connect');
    try {
      window.location.href = await startXeroConnect();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not start the Xero connection');
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect Xero? Signed proposals will stop creating draft invoices until you reconnect.')) return;
    setBusy('disconnect');
    try {
      await disconnectXero();
      setAccounts([]);
      await reload();
      toast('Xero disconnected');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not disconnect');
    } finally {
      setBusy(null);
    }
  };

  const chooseAccount = async (field: 'account_code' | 'mrr_account_code', code: string) => {
    setBusy('save');
    try {
      const picked = accounts.find(a => a.code === code);
      // Send both codes every time: a partial upsert would null the other one.
      await saveXeroSettings({
        account_code: field === 'account_code' ? code : (status?.sales_account_code ?? ''),
        mrr_account_code: field === 'mrr_account_code' ? code : (status?.mrr_account_code ?? ''),
        tax_type: picked?.taxType ?? status?.tax_type ?? undefined,
      });
      await reload();
      toast('Saved');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="h-40 animate-pulse rounded-xl bg-white card-shadow" />;
  }

  return (
    <section className="rounded-xl bg-white p-5 card-shadow">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Xero</h3>
          <p className="mt-0.5 text-sm text-gray-500">
            When a client signs, a <strong>draft</strong> invoice is created in Xero covering the one-time fees plus the
            first month of any retainer, with each line coded to its own revenue account. Draft means Xero never emails
            the client: you approve and send it yourself.
          </p>
        </div>
        {status?.connected ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
            <Check className="h-3.5 w-3.5" /> Connected{status.tenant_name ? `: ${status.tenant_name}` : ''}
          </span>
        ) : (
          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-500">Not connected</span>
        )}
      </div>

      {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

      {!status?.credentials_configured && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <p className="font-semibold">Xero app credentials are not set yet.</p>
          <p className="mt-1">
            Create a Web app at developer.xero.com, then set XERO_CLIENT_ID and XERO_CLIENT_SECRET as edge function
            secrets. Use this exact redirect URI in the Xero app:
          </p>
          <code className="mt-2 block break-all rounded bg-white/70 px-2 py-1 font-mono text-[11px]">
            {status?.redirect_uri}
          </code>
        </div>
      )}

      {status?.last_error && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Last Xero error: {status.last_error}
        </p>
      )}

      {status?.connected && (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {/* No shared MRR account: each family carries its own (Zak, Oct 2026). */}
            <div>
              <label className="text-[11px] font-medium text-gray-500">Fallback one-time account</label>
              <div className="mt-1">
                <Select
                  value={status.sales_account_code ?? ''}
                  onValueChange={code => void chooseAccount('account_code', code)}
                  disabled={busy !== null || accounts.length === 0}
                >
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue placeholder={accounts.length ? 'Choose an account' : 'Loading accounts…'} />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map(a => (
                      <SelectItem key={a.code} value={a.code}>
                        <SelectItemText>{a.code} - {a.name}</SelectItemText>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="mt-1 text-[11px] text-gray-400">
                Used only when a service has no one-time account of its own.
              </p>
            </div>
          </div>
          {status.last_refreshed_at && (
            <p className="flex items-center gap-1.5 text-[11px] text-gray-400">
              <RefreshCw className="h-3 w-3" />
              Token last refreshed {new Date(status.last_refreshed_at).toLocaleString()}. A weekly job keeps it alive.
            </p>
          )}
        </div>
      )}

      <div className="mt-4">
        <XeroServiceAccountsEditor accounts={accounts} mrrAccountCode={status?.mrr_account_code ?? null} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {status?.connected ? (
          <>
            <a
              href="https://go.xero.com/app/invoicing"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              Open Xero invoices <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <button
              type="button"
              onClick={disconnect}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
            >
              {busy === 'disconnect' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />}
              Disconnect
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={connect}
            disabled={busy !== null || !status?.credentials_configured}
            className="inline-flex items-center gap-1.5 rounded-lg gradient-bg px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy === 'connect' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
            Connect to Xero
          </button>
        )}
      </div>
    </section>
  );
}
