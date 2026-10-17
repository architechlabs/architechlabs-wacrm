/**
 * Finish production cutover: apply migration 047, sync Cloudflare Worker secrets
 * from .env.local, deploy, and verify the WhatsApp webhook challenge.
 *
 * Required in .env.local (or environment):
 *   CLOUDFLARE_API_TOKEN
 *   SUPABASE_ACCESS_TOKEN  — or —  SUPABASE_DB_URL (Postgres URI)
 *
 * Does not print secret values.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PROJECT_REF = 'nthvtmzvmjiowvjgitmv';
const CLOUDFLARE_ACCOUNT_ID = 'f8fcf42a91f7fbf1cb89022ead312069';
const WORKER_NAME = 'architech-wacrm';
const MIGRATION_FILE = 'supabase/migrations/047_multi_whatsapp_numbers.sql';
const PRODUCTION_ORIGIN = 'https://whatsapp.architechlabs.in';

const WORKER_SECRETS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'ENCRYPTION_KEY',
  'META_APP_SECRET',
  'META_WEBHOOK_VERIFY_TOKEN',
  'META_APP_ID',
  'META_CONFIG_ID',
  'META_GRAPH_API_VERSION',
  'META_SYSTEM_USER_TOKEN',
  'DEFAULT_WABA_ID',
];

function loadEnvLocal() {
  const file = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

function mergeEnv() {
  return { ...loadEnvLocal(), ...process.env };
}

async function migration047Applied(env) {
  const base = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  }
  const res = await fetch(`${base}/rest/v1/whatsapp_config?select=is_default&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  return res.status === 200;
}

async function supabaseManagementQuery(accessToken, query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase Management API query failed (${res.status}): ${body.slice(0, 800)}`);
  }
}

async function applyMigration047(env) {
  if (await migration047Applied(env)) {
    console.log('Migration 047: already applied (whatsapp_config.is_default exists).');
    return;
  }

  const sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  console.log('Migration 047: applying to hosted Supabase…');

  if (env.SUPABASE_ACCESS_TOKEN) {
    await supabaseManagementQuery(env.SUPABASE_ACCESS_TOKEN, sql);
  } else if (env.SUPABASE_DB_URL) {
    const { default: postgres } = await import('postgres');
    const db = postgres(env.SUPABASE_DB_URL, { max: 1, ssl: 'require' });
    try {
      await db.unsafe(sql);
    } finally {
      await db.end({ timeout: 5 });
    }
  } else {
    throw new Error('Set SUPABASE_ACCESS_TOKEN or SUPABASE_DB_URL in .env.local');
  }

  if (!(await migration047Applied(env))) {
    throw new Error('Migration 047 ran but is_default column is still missing — check Supabase logs.');
  }
  console.log('Migration 047: applied successfully.');
}

async function assertArchitechWorkerReachable(env) {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN in .env.local');

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${WORKER_NAME}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status === 404) {
    throw new Error(
      `Worker "${WORKER_NAME}" was not found on Architech account ${CLOUDFLARE_ACCOUNT_ID}. ` +
        'Use a Cloudflare API token for that account only — not a personal/other account.',
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Cannot access ${WORKER_NAME} on Architech Cloudflare account (${res.status}): ${body.slice(0, 200)}`,
    );
  }
}

function syncWorkerSecrets(env) {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN in .env.local');

  for (const name of WORKER_SECRETS) {
    const value = env[name];
    if (!value) {
      console.warn(`Worker secret ${name}: skipped (not in .env.local)`);
      continue;
    }
    console.log(`Worker secret ${name}: updating…`);
    const result = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
      input: `${value}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: true,
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
    });
    if (result.status !== 0) {
      throw new Error(`wrangler secret put ${name} failed (exit ${result.status})`);
    }
  }
}

function deployWorker(env) {
  console.log('Deploying to Cloudflare (opennextjs-cloudflare)…');
  const result = spawnSync('npm', ['run', 'deploy'], {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN,
      NEXT_PUBLIC_SITE_URL: PRODUCTION_ORIGIN,
    },
  });
  if (result.status !== 0) {
    throw new Error(`npm run deploy failed (exit ${result.status})`);
  }
}

async function verifyProductionWebhook(env) {
  const verifyToken = env.META_WEBHOOK_VERIFY_TOKEN;
  if (!verifyToken) throw new Error('META_WEBHOOK_VERIFY_TOKEN missing');

  const challenge = 'wacrm-setup-verify';
  const url =
    `${PRODUCTION_ORIGIN}/api/whatsapp/webhook` +
    `?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}` +
    `&hub.challenge=${challenge}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (res.status === 200 && text === challenge) {
    console.log('Production webhook: verify token matches Meta.');
    return;
  }
  throw new Error(`Production webhook verify failed (${res.status}): ${text.slice(0, 200)}`);
}

async function main() {
  const env = mergeEnv();
  await applyMigration047(env);
  await assertArchitechWorkerReachable(env);
  syncWorkerSecrets(env);
  deployWorker(env);
  console.log('Waiting 8s for propagation…');
  await new Promise((r) => setTimeout(r, 8000));
  await verifyProductionWebhook(env);
  console.log('Done. Open Settings → WhatsApp to connect numbers; Meta webhook is already on whatsapp.architechlabs.in.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
