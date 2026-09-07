import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  exchange: vi.fn(),
  cookies: undefined as
    | undefined
    | {
        getAll: () => unknown[];
        setAll: (
          values: { name: string; value: string; options: { path: string } }[]
        ) => void;
      },
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: { cookies: typeof mocks.cookies }
  ) => {
    mocks.cookies = options.cookies;
    return { auth: { exchangeCodeForSession: mocks.exchange } };
  },
}));
import { GET } from './route';

beforeEach(() => {
  mocks.cookies = undefined;
  mocks.exchange.mockReset();
  mocks.exchange.mockResolvedValue({ data: { session: {} }, error: null });
});

describe('OAuth callback', () => {
  it('preserves session cookies on a private, local success redirect', async () => {
    mocks.exchange.mockImplementation(async () => {
      mocks.cookies?.setAll([
        { name: 'test-session', value: 'test-only', options: { path: '/' } },
      ]);
      return { data: { session: {} }, error: null };
    });
    const result = await GET(
      new NextRequest(
        'https://app.test/auth/callback?code=test-code&next=https://evil.test'
      )
    );
    expect(result.headers.get('location')).toBe('https://app.test/dashboard');
    expect(result.cookies.get('test-session')?.value).toBe('test-only');
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('preserves invitation navigation', async () => {
    const result = await GET(
      new NextRequest(
        'https://app.test/auth/callback?code=test-code&invite=invite-a'
      )
    );
    expect(result.headers.get('location')).toBe(
      'https://app.test/join/invite-a'
    );
  });
  it('redirects missing/denied codes without exchanging or reflecting provider details', async () => {
    const result = await GET(
      new NextRequest(
        'https://app.test/auth/callback?error=denied&error_description=sensitive'
      )
    );
    expect(result.headers.get('location')).toBe(
      'https://app.test/login?auth_error=oauth'
    );
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it('handles an expired/reused code without an uncaught exception', async () => {
    mocks.exchange.mockResolvedValue({
      data: { session: null },
      error: { message: 'sensitive' },
    });
    const result = await GET(
      new NextRequest('https://app.test/auth/callback?code=test-code')
    );
    expect(result.headers.get('location')).toBe(
      'https://app.test/login?auth_error=oauth'
    );
  });
  it('catches unexpected failures and logs only a fixed safe diagnostic', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mocks.exchange.mockRejectedValue(new Error('sensitive'));
      const result = await GET(
        new NextRequest('https://app.test/auth/callback?code=test-code')
      );
      expect(result.status).toBe(307);
      expect(result.headers.get('location')).toContain(
        '/login?auth_error=oauth'
      );
      expect(log).toHaveBeenCalledWith(
        '[auth/callback] Session exchange failed'
      );
    } finally {
      log.mockRestore();
    }
  });
});
