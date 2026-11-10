/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('./supabase', () => ({ supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } } }));

import { PublicLoadError, resolvePublicInvoke } from './public-fetch';
import { fetchPublicDocument } from './documents-db';
import { fetchPublicProposal } from './proposals-db';
import { fetchPublicAuditReportBundle } from './db';

const httpError = (status: number) => ({ name: 'FunctionsHttpError', context: { status } });

describe('resolvePublicInvoke', () => {
  it('returns the body when ok', () => {
    expect(resolvePublicInvoke({ ok: true, x: 1 }, null)).toEqual({ ok: true, x: 1 });
  });
  it('returns null for 404 and 400', () => {
    expect(resolvePublicInvoke(null, httpError(404))).toBeNull();
    expect(resolvePublicInvoke(null, httpError(400))).toBeNull();
  });
  it('returns null for an ok:false not_found body', () => {
    expect(resolvePublicInvoke({ ok: false, error: { code: 'not_found' } }, null)).toBeNull();
  });
  it('throws a retryable error for 500, network errors and odd bodies', () => {
    expect(() => resolvePublicInvoke(null, httpError(500))).toThrow(PublicLoadError);
    expect(() => resolvePublicInvoke(null, { name: 'FunctionsFetchError', context: new Error('offline') })).toThrow(PublicLoadError);
    expect(() => resolvePublicInvoke({ ok: false, error: { code: 'request_failed' } }, null)).toThrow(PublicLoadError);
    expect(() => resolvePublicInvoke(null, null)).toThrow(PublicLoadError);
  });
});

describe('public fetchers', () => {
  beforeEach(() => invoke.mockReset());

  const fetchers = {
    proposal: (t: string) => fetchPublicProposal(t),
    document: (t: string) => fetchPublicDocument(t),
    report: (t: string) => fetchPublicAuditReportBundle(t),
  };

  for (const [name, fetcher] of Object.entries(fetchers)) {
    it(`${name}: 404 means not found (null)`, async () => {
      invoke.mockResolvedValue({ data: null, error: httpError(404) });
      await expect(fetcher('tok')).resolves.toBeNull();
    });

    it(`${name}: 500 throws so the page can retry`, async () => {
      invoke.mockResolvedValue({ data: null, error: httpError(500) });
      await expect(fetcher('tok')).rejects.toBeInstanceOf(PublicLoadError);
    });
  }

  it('proposal: ok body comes back as the payload', async () => {
    invoke.mockResolvedValue({ data: { ok: true, proposal: { title: 'P' } }, error: null });
    await expect(fetchPublicProposal('tok')).resolves.toMatchObject({ proposal: { title: 'P' } });
  });
});
