import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Client Components are also prerendered by Next.js on the server. A
      // module-level Supabase singleton therefore outlives the Worker request
      // that created its auth initialization promise, and a later request can
      // fail with Cloudflare's cross-request I/O exception (Error 1101).
      //
      // Keep the lock-safe singleton in the real browser, but create an
      // isolated client for every server-side call. This mirrors the default
      // @supabase/ssr policy explicitly and prevents future wrapper-level
      // caching from reintroducing the Worker leak.
      isSingleton: typeof window !== 'undefined',
    }
  );
}
