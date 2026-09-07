# Google sign-in setup

The app supports Supabase Google OAuth (PKCE). Email/password login remains
available. No Google client secret belongs in the application or git.

Before enabling this in production:

1. In Google Auth Platform, configure a Web application OAuth client with the
   intended audience and only the basic OpenID/email/profile scopes.
2. Add the application origin to its authorized JavaScript origins. Add the
   **Supabase** OAuth callback shown under Supabase Authentication → Providers →
   Google as Google's authorized redirect URI (not the app's callback).
3. Enter the Google client ID and secret in that Supabase provider panel and
   enable Google. Do not paste these values into chat or application source.
4. Confirm the Supabase redirect allowlist permits the application's
   `/auth/callback` URL, including its optional `invite` query parameter.
   Configure localhost separately when testing locally.
5. Use Continue with Google on `/login`, selecting the email used by the existing
   CRM account. Verify the existing account/conversations are still available.
   A different email may create a separate account; do not manually merge data.
6. Verify sign-out, sign-in, invite acceptance, and an independent second browser
   session. Password login remains the fallback if provider setup is incomplete.

The callback exchanges the one-use code with Supabase, preserves response cookies,
and redirects only to `/dashboard` or an encoded local invitation path. Errors
return a generic login notice. Callback responses are private/no-store.

Provider configuration and live Google login must be verified separately; local
unit tests cannot prove external provider setup is correct.

Reference: https://supabase.com/docs/guides/auth/social-login/auth-google
