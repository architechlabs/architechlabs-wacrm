import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loginDestination, startGoogleSignIn } from './google-sign-in';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ external: { google: true } }))
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('Google sign-in', () => {
  it('uses Supabase OAuth and the current origin callback', async () => {
    const signInWithOAuth = vi.fn(async () => ({ error: null }));
    const client = { auth: { signInWithOAuth } } as unknown as SupabaseClient;
    await startGoogleSignIn(client, 'https://app.test', 'invite-a');
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: 'https://app.test/auth/callback?invite=invite-a' },
    });
  });
  it('keeps destinations local even with a malicious invitation value', () => {
    expect(loginDestination(null)).toBe('/dashboard');
    expect(loginDestination('//evil.test')).toBe('/join/%2F%2Fevil.test');
  });
  it('does not expose provider errors', async () => {
    const client = {
      auth: {
        signInWithOAuth: async () => ({ error: { message: 'sensitive' } }),
      },
    } as unknown as SupabaseClient;
    await expect(
      startGoogleSignIn(client, 'https://app.test', null)
    ).rejects.toThrow('Google sign-in could not start.');
  });
  it('does not redirect to an unconfigured provider', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ external: { google: false } })
    );
    const signInWithOAuth = vi.fn();
    const client = { auth: { signInWithOAuth } } as unknown as SupabaseClient;
    await expect(
      startGoogleSignIn(client, 'https://app.test', null)
    ).rejects.toThrow('Google sign-in is not enabled');
    expect(signInWithOAuth).not.toHaveBeenCalled();
  });
  it('keeps the login form available when provider discovery fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 503 }));
    const signInWithOAuth = vi.fn();
    const client = { auth: { signInWithOAuth } } as unknown as SupabaseClient;
    await expect(
      startGoogleSignIn(client, 'https://app.test', null)
    ).rejects.toThrow('Sign-in provider check unavailable');
    expect(signInWithOAuth).not.toHaveBeenCalled();
  });
});
