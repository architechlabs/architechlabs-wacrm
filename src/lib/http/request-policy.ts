/**
 * Request policies shared by Next config and auth middleware.
 *
 * Keep these rules data-only so they can be exercised with Next's config
 * testing utilities without importing the full application configuration.
 */
export const ROOT_REDIRECT = {
  source: '/',
  destination: '/dashboard',
  permanent: false,
} as const;

export const PRIVATE_CACHE_CONTROL = 'private, no-store, max-age=0';
export const API_CACHE_CONTROL = 'no-store';
export const PUBLIC_SHELL_CACHE_CONTROL =
  'public, max-age=0, s-maxage=300, stale-while-revalidate=86400';

/**
 * Every path rendered by the authenticated dashboard route group, plus the
 * token-bearing join flow. These responses must never enter a shared cache,
 * including their RSC variants and redirects.
 */
export const PRIVATE_APP_PATHS = [
  '/agents',
  '/automations',
  '/broadcasts',
  '/contacts',
  '/dashboard',
  '/flows',
  '/inbox',
  '/join',
  '/notifications',
  '/pipelines',
  '/settings',
] as const;

/** Public, data-free auth shells may retain the short anti-staleness policy. */
export const PUBLIC_SHELL_PATHS = [
  '/forgot-password',
  '/login',
  '/signup',
] as const;

export function isPrivateAppPathname(pathname: string): boolean {
  return PRIVATE_APP_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
}

export function createCacheHeaderRules() {
  return [
    {
      source: '/api/:path*',
      headers: [{ key: 'Cache-Control', value: API_CACHE_CONTROL }],
    },
    ...PUBLIC_SHELL_PATHS.map((source) => ({
      source,
      headers: [{ key: 'Cache-Control', value: PUBLIC_SHELL_CACHE_CONTROL }],
    })),
    ...PRIVATE_APP_PATHS.map((path) => ({
      source: `${path}/:path*`,
      headers: [{ key: 'Cache-Control', value: PRIVATE_CACHE_CONTROL }],
    })),
  ];
}
