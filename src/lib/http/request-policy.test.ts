import { AsyncLocalStorage } from 'node:async_hooks';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  API_CACHE_CONTROL,
  createCacheHeaderRules,
  PRIVATE_CACHE_CONTROL,
  PUBLIC_SHELL_CACHE_CONTROL,
  ROOT_REDIRECT,
} from './request-policy';

type NextTestingServer = typeof import('next/experimental/testing/server');

let nextTesting: NextTestingServer;

beforeAll(async () => {
  // Next's test utilities use the same runtime global that Next installs in
  // production. Vitest's plain Node environment does not install it for us.
  Object.assign(globalThis, { AsyncLocalStorage });
  nextTesting = await import('next/experimental/testing/server');
});

const nextConfig = {
  async redirects() {
    return [ROOT_REDIRECT];
  },
  async headers() {
    return createCacheHeaderRules();
  },
};

describe('root request policy', () => {
  it('redirects only the exact root path to the internal dashboard path', async () => {
    const response = await nextTesting.unstable_getResponseFromNextConfig({
      url: 'https://app.test/',
      nextConfig,
    });

    expect(response.status).toBe(307);
    expect(nextTesting.getRedirectUrl(response)).toBe(
      'https://app.test/dashboard'
    );

    const nonRootResponse =
      await nextTesting.unstable_getResponseFromNextConfig({
        url: 'https://app.test/login',
        nextConfig,
      });
    expect(nonRootResponse.headers.get('location')).toBeNull();
  });
});

describe('response cache policy', () => {
  it.each(['/dashboard', '/inbox', '/contacts', '/settings'])(
    'marks %s HTML private and non-cacheable',
    async (pathname) => {
      const response = await nextTesting.unstable_getResponseFromNextConfig({
        url: `https://app.test${pathname}`,
        nextConfig,
      });

      expect(response.headers.get('cache-control')).toBe(PRIVATE_CACHE_CONTROL);
    }
  );

  it('applies the same private policy to an RSC request', async () => {
    const response = await nextTesting.unstable_getResponseFromNextConfig({
      url: 'https://app.test/inbox?_rsc=test',
      headers: { rsc: '1' },
      nextConfig,
    });

    expect(response.headers.get('cache-control')).toBe(PRIVATE_CACHE_CONTROL);
  });

  it('keeps the data-free login shell briefly cacheable', async () => {
    const response = await nextTesting.unstable_getResponseFromNextConfig({
      url: 'https://app.test/login',
      nextConfig,
    });

    expect(response.headers.get('cache-control')).toBe(
      PUBLIC_SHELL_CACHE_CONTROL
    );
  });

  it('keeps API responses out of caches', async () => {
    const response = await nextTesting.unstable_getResponseFromNextConfig({
      url: 'https://app.test/api/whatsapp/config',
      nextConfig,
    });

    expect(response.headers.get('cache-control')).toBe(API_CACHE_CONTROL);
  });
});
