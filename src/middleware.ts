import { createServerClient } from '@supabase/ssr'
import type { User } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'
import {
  API_CACHE_CONTROL,
  isPrivateAppPathname,
  PRIVATE_CACHE_CONTROL,
} from '@/lib/http/request-policy'

const MAX_AUTH_ERROR_MESSAGE_LENGTH = 300

function sanitizeAuthDiagnostic(value: string, maxLength = MAX_AUTH_ERROR_MESSAGE_LENGTH) {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(
      /\b(access[_-]?token|refresh[_-]?token|authorization|cookie|api[_-]?key|apikey|secret)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1$2[redacted]'
    )
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\b/g, '[redacted-jwt]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted-value]')
    .slice(0, maxLength)
}

function logAuthError(error: unknown, pathname: string, outcome: 'failed' | 'threw') {
  const isError = error instanceof Error
  const errorName = sanitizeAuthDiagnostic(
    isError ? error.name || 'Error' : 'NonErrorThrown',
    80
  )
  const message = sanitizeAuthDiagnostic(
    isError
      ? error.message || 'Authentication validation failed'
      : typeof error === 'string'
        ? error
        : 'Authentication validation failed'
  )

  // Log only this allowlisted diagnostic shape. In particular, never pass the
  // Error, request, headers, or cookies themselves to the logger because those
  // objects can contain credentials or session tokens.
  console.error(`[middleware] Supabase auth validation ${outcome}`, {
    errorName,
    errorType: isError ? 'Error' : typeof error,
    message,
    pathname,
  })
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0]
  const authCookieName = `sb-${projectRef}-auth-token`
  const incomingAuthCookieNames = request.cookies.getAll()
    .map(({ name }) => name)
    .filter((name) =>
      name === authCookieName || name.startsWith(`${authCookieName}.`) ||
      name === `${authCookieName}-code-verifier` ||
      name.startsWith(`${authCookieName}-code-verifier.`)
    )

  const supabase = createServerClient(
    supabaseUrl,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  let user: User | null = null
  let authFailed = false

  try {
    const { data, error } = await supabase.auth.getUser()
    if (error) {
      // getUser() also returns AuthSessionMissingError for an ordinary visitor
      // with no auth cookie. That is the normal logged-out state, not a failed
      // refresh and not something that should generate an error log.
      if (incomingAuthCookieNames.length > 0) {
        authFailed = true
        logAuthError(error, request.nextUrl.pathname, 'failed')
      }
    } else {
      user = data.user
    }
  } catch (error) {
    authFailed = true
    logAuthError(error, request.nextUrl.pathname, 'threw')
  }

  if (authFailed) {
    // A failed refresh can leave a stale refresh token in the browser. If it
    // survives this response, every protected request retries the same broken
    // auth state. Clear only this Supabase project's session / PKCE cookies so
    // the next request starts logged out instead of looping or escaping the
    // Worker as an unhandled exception.
    incomingAuthCookieNames.forEach((name) => {
      request.cookies.delete(name)
      supabaseResponse.cookies.set(name, '', {
        maxAge: 0,
        path: '/',
        sameSite: 'lax',
        secure: request.nextUrl.protocol === 'https:',
      })
    })
  }

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  const withPrivateCache = <T extends NextResponse>(response: T): T => {
    response.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL)
    return response
  }

  // Protect both HTML and RSC pass-through responses. setAll() can replace
  // supabaseResponse during getUser(), so apply this only after auth settles.
  if (isPrivateAppPathname(request.nextUrl.pathname)) {
    supabaseResponse.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL)
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withPrivateCache(withRefreshedCookies(NextResponse.redirect(url)))
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withPrivateCache(withRefreshedCookies(NextResponse.redirect(url)))
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    const response = withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
    response.headers.set('Cache-Control', API_CACHE_CONTROL)
    return response
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!$|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
