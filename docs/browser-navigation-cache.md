# Browser navigation cache

The app uses Next.js 16's experimental `staleTimes.dynamic: 30` to reuse
visited page payloads in the current tab for up to 30 seconds. Sidebar and
header links disable speculative prefetch, so merely displaying the menu
does not request every destination from the Worker.

This caches the route payload, not Supabase query results. The current pages
load private business data in client components; their queries and realtime
subscriptions remain unchanged. Middleware and API authorization remain in
place on server requests. Private HTML/RSC and APIs retain their existing
`no-store` HTTP policy. There is no service worker, localStorage data cache,
Redis service, or public cache of private responses.

Login and explicit logout already perform full document navigations, which
discard the in-memory Router Cache. AuthProvider continues observing session
changes and the dashboard shell hides children when signed out. Database RLS
and API role checks remain authoritative; a cached screen grants no access.
Future server-rendered private data must be reviewed before extending this
policy. Do not increase the TTL to cache permissions or session validity.

## Verification

Use a **production build** (prefetch/cache behavior differs in dev):

1. Sign in. In DevTools Network, leave Disable cache unchecked. Filter by
   `_rsc` and clear the list after the initial page has loaded.
2. Visit Inbox, Notifications, and Dashboard once, then repeat within 30
   seconds. Compare repeat route requests with first visits. The shell should
   not prefetch every menu destination in the background.
3. Confirm Supabase reads and realtime still run and existing messages load.
   Do not send a message just to test caching.
4. After the TTL, revisit a page; a server request is expected. A hard refresh
   or new tab also needs the server and is not protected against error 1102.
5. Sign out, then sign in with another authorized account. Verify no previous
   account's data appears and protected requests still enforce authentication.

This reduces navigation requests; it does not increase the Workers Free CPU
allowance or establish that 1102 is fixed. The initial visit can be slower
without speculative prefetch. Measure real request counts before claiming
a production performance improvement.
