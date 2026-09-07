import type { SupabaseClient } from '@supabase/supabase-js';
import { readWithTimeout } from '@/lib/http/read-with-timeout';

/** Only app-owned destinations; never accept an arbitrary post-login URL. */
export function loginDestination(invite: string | null): string {
  return invite ? `/join/${encodeURIComponent(invite)}` : '/dashboard';
}

export async function startGoogleSignIn(
  supabase: SupabaseClient,
  origin: string,
  invite: string | null
) {
  // OAuth URL creation alone does not check whether Google is enabled. Check
  // the public provider flag only on click so incomplete setup stays in the
  // login form instead of navigating the user to Supabase's JSON error page.
  const googleEnabled = await readWithTimeout(async (signal) => {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/settings`,
      {
        headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! },
        credentials: 'omit',
        cache: 'no-store',
        signal,
      }
    );
    if (!response.ok) throw new Error('Sign-in provider check unavailable');
    const settings = await response.json();
    return settings.external?.google === true;
  });
  if (!googleEnabled)
    throw new Error(
      'Google sign-in is not enabled. Use email and password until setup is complete.'
    );
  const callback = new URL('/auth/callback', origin);
  if (invite) callback.searchParams.set('invite', invite);
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: callback.toString() },
  });
  if (error)
    throw new Error(
      'Google sign-in could not start. Please try email and password or contact your administrator.'
    );
}
