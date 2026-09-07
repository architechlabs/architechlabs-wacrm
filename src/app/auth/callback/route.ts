import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { loginDestination } from '@/lib/auth/google-sign-in';
import { PRIVATE_CACHE_CONTROL } from '@/lib/http/request-policy';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const invite = request.nextUrl.searchParams.get('invite');
  const failure = new URL('/login', request.url);
  failure.searchParams.set('auth_error', 'oauth');
  if (invite) failure.searchParams.set('invite', invite);
  // Keep one response so PKCE session cookies survive both redirects.
  const response = NextResponse.redirect(failure);
  response.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL);
  response.headers.set('Referrer-Policy', 'no-referrer');
  if (!code || request.nextUrl.searchParams.has('error')) return response;

  try {
    // Request-local client. This route handles its own cookies; middleware
    // must not clear the PKCE verifier before this exchange can consume it.
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => request.cookies.getAll(),
          setAll: (cookies) => {
            for (const { name, value, options } of cookies) {
              request.cookies.set(name, value);
              response.cookies.set(name, value, options);
            }
          },
        },
      }
    );
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error && data.session) {
      response.headers.set(
        'Location',
        new URL(loginDestination(invite), request.url).toString()
      );
    }
  } catch {
    // Do not log OAuth codes, cookie data or provider responses.
    console.error('[auth/callback] Session exchange failed');
  }
  return response;
}
