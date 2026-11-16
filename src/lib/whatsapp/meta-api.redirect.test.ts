import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetaApiError, sendTemplateMessage } from './meta-api';

describe('template send redirects', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([true, false])('rejects a redirect without forwarding credentials (signal: %s)', async hasSignal => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://untrusted.example/' } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(sendTemplateMessage({ phoneNumberId: 'line', accessToken: 'test-token', to: '919999999999', templateName: 'welcome', ...(hasSignal ? { signal: new AbortController().signal } : {}) })).rejects.toBeInstanceOf(MetaApiError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });
  it('rejects opaque redirects as unknown outcomes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, type: 'opaqueredirect', status: 0, json: async () => { throw new Error('no body'); } }));
    await expect(sendTemplateMessage({ phoneNumberId: 'line', accessToken: 'test-token', to: '919999999999', templateName: 'welcome' })).rejects.toMatchObject({ code: undefined });
  });
});
