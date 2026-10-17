<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Learned User Preferences

- Prefer static codebase analysis over running build or dev-server commands when the user's machine is slow, unless they explicitly ask to run them.
- Keep agent scope to this architechlabs-wacrm WhatsApp CRM repo only; do not change other Cloudflare workers or unrelated Supabase projects.
- For Cloudflare infrastructure changes, only modify the `architech-wacrm` worker defined in `wrangler.jsonc`.
- When implementing from an attached plan, do not edit the plan file itself.
- All WhatsApp management should live in architechlabs-wacrm; Connectly is deprecated and should not be reintroduced.

## Learned Workspace Facts

- architechlabs-wacrm is Architech Labs' centralized WhatsApp CRM (open-source WACRM fork), replacing the Connectly prototype.
- Architech Labs is a Meta verified tech provider onboarding its own numbers and third-party client WABA numbers.
- Multi-number tenancy uses one Architech workspace with an inbox number switcher, not separate workspaces per client.
- Multi-number schema lives in Supabase migration `047_multi_whatsapp_numbers.sql`.
- Production is served at whatsapp.architechlabs.in via Cloudflare Worker `architech-wacrm`.
- Primary database for this app is Supabase project ref `nthvtmzvmjiowvjgitmv`.
- Stack: Next.js app, Supabase migrations, Meta WhatsApp Cloud API (Embedded Signup and Coexistence), OpenNext deploy to Cloudflare Workers.
