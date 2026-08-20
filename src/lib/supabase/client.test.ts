import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { createBrowserClient } = vi.hoisted(() => ({
  createBrowserClient: vi.fn(() => ({})),
}));

vi.mock('@supabase/ssr', () => ({ createBrowserClient }));

const { createClient } = await import('./client');

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createClient', () => {
  it('disables the singleton while Client Components are prerendered', () => {
    vi.stubGlobal('window', undefined);

    createClient();
    createClient();

    expect(createBrowserClient).toHaveBeenCalledTimes(2);
    expect(createBrowserClient).toHaveBeenNthCalledWith(
      1,
      'https://test.supabase.co',
      'anon-key',
      { isSingleton: false }
    );
    expect(createBrowserClient).toHaveBeenNthCalledWith(
      2,
      'https://test.supabase.co',
      'anon-key',
      { isSingleton: false }
    );
  });

  it('preserves Supabase browser singleton behavior after hydration', () => {
    vi.stubGlobal('window', {});

    createClient();
    createClient();

    expect(createBrowserClient).toHaveBeenCalledTimes(2);
    expect(createBrowserClient).toHaveBeenNthCalledWith(
      1,
      'https://test.supabase.co',
      'anon-key',
      { isSingleton: true }
    );
    expect(createBrowserClient).toHaveBeenNthCalledWith(
      2,
      'https://test.supabase.co',
      'anon-key',
      { isSingleton: true }
    );
  });
});
