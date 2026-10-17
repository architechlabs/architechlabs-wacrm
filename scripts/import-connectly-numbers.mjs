/**
 * One-time import: Connectly Neon business_accounts → Supabase whatsapp_config.
 * Uses per-row access_token when present; otherwise META_SYSTEM_USER_TOKEN.
 *
 * Usage: node scripts/import-connectly-numbers.mjs [--dry-run] [--include-aradhya]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import postgres from 'postgres';
import { createClient } from '@supabase/supabase-js';

const ARCHITECH_ACCOUNT_ID = '90e47f37-19d5-4fb8-94f8-8c2df7599f7e';
const dryRun = process.argv.includes('--dry-run');
const includeAradhya = process.argv.includes('--include-aradhya');

function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    env[t.slice(0, i)] = t.slice(i + 1);
  }
  return env;
}

function wacrmEncrypt(text, hexKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}:${cipher.getAuthTag().toString('hex')}`;
}

function connectlyDecrypt(payload, keyB64) {
  if (!payload?.iv || !payload?.tag || !payload?.data) return null;
  const key = Buffer.from(keyB64, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const data = Buffer.from(payload.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

async function subscribeWaba(wabaId, accessToken, graphVersion) {
  const url = `https://graph.facebook.com/${graphVersion}/${wabaId}/subscribed_apps`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (res.ok) return;
  const body = await res.json().catch(() => ({}));
  const msg = body?.error?.message ?? `subscribe failed ${res.status}`;
  if (!/already/i.test(msg)) throw new Error(`WABA ${wabaId}: ${msg}`);
}

async function requestSmbSync(phoneNumberId, accessToken, syncType, graphVersion) {
  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/smb_app_data`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', sync_type: syncType }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    console.warn(`smb sync ${syncType} for ${phoneNumberId}:`, body?.error?.message ?? res.status);
  }
}

const env = loadEnv();
const connectlyUrl = env.DATABASE_URL || env.CONNECTLY_DATABASE_URL;
if (!connectlyUrl) {
  console.error('Set CONNECTLY_DATABASE_URL or DATABASE_URL in .env.local');
  process.exit(1);
}
for (const key of ['ENCRYPTION_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'META_GRAPH_API_VERSION']) {
  if (!env[key]) {
    console.error(`Missing ${key}`);
    process.exit(1);
  }
}
const fallbackToken = env.META_SYSTEM_USER_TOKEN?.trim();
if (!fallbackToken) {
  console.error('META_SYSTEM_USER_TOKEN required when Connectly rows lack tokens');
  process.exit(1);
}

const neon = postgres(connectlyUrl, { ssl: 'require', max: 1 });
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: existingRows, error: existingErr } = await supabase
  .from('whatsapp_config')
  .select('id, user_id, phone_number_id, is_default')
  .eq('account_id', ARCHITECH_ACCOUNT_ID);
if (existingErr) throw existingErr;

const ownerUserId = existingRows?.[0]?.user_id;
if (!ownerUserId) {
  console.error('No whatsapp_config on Architech account — add one line manually first.');
  process.exit(1);
}

const defaultPhoneId = existingRows.find((r) => r.is_default)?.phone_number_id
  ?? existingRows[0].phone_number_id;

const connectlyRows = await neon`
  select id, waba_id, phone_number_id, display_phone_number, name, status,
         is_on_biz_app, subscribed, access_token
  from business_accounts
  where phone_number_id is not null
    and upper(coalesce(status, '')) = 'CONNECTED'
  order by id
`;

const toImport = connectlyRows.filter((row) => {
  if (row.id === 63 && !includeAradhya) return false;
  return true;
});

const encryptedVerify = env.META_WEBHOOK_VERIFY_TOKEN
  ? wacrmEncrypt(env.META_WEBHOOK_VERIFY_TOKEN, env.ENCRYPTION_KEY)
  : null;

const subscribedWabas = new Set();
const now = new Date().toISOString();
let inserted = 0;
let updated = 0;

for (const row of toImport) {
  const plainToken =
    connectlyDecrypt(row.access_token, env.CHAT_DATA_ENCRYPTION_KEY) || fallbackToken;

  if (!subscribedWabas.has(row.waba_id)) {
    if (!dryRun) await subscribeWaba(row.waba_id, plainToken, env.META_GRAPH_API_VERSION);
    subscribedWabas.add(row.waba_id);
    console.log(`subscribed WABA ${row.waba_id}`);
  }

  if (row.is_on_biz_app && !dryRun) {
    await requestSmbSync(row.phone_number_id, plainToken, 'smb_app_state_sync', env.META_GRAPH_API_VERSION);
    await requestSmbSync(row.phone_number_id, plainToken, 'history', env.META_GRAPH_API_VERSION);
  }

  const payload = {
    account_id: ARCHITECH_ACCOUNT_ID,
    user_id: ownerUserId,
    phone_number_id: row.phone_number_id,
    waba_id: row.waba_id,
    display_phone_number: row.display_phone_number,
    verified_name: row.name,
    is_on_biz_app: Boolean(row.is_on_biz_app),
    is_default: row.phone_number_id === defaultPhoneId,
    source: 'manual',
    access_token: wacrmEncrypt(plainToken, env.ENCRYPTION_KEY),
    verify_token: encryptedVerify,
    status: 'connected',
    connected_at: now,
    subscribed_apps_at: now,
    registered_at: row.is_on_biz_app ? now : null,
    last_registration_error: null,
    updated_at: now,
  };

  const existing = existingRows.find((r) => r.phone_number_id === row.phone_number_id);
  if (dryRun) {
    console.log(existing ? 'would update' : 'would insert', row.display_phone_number, row.phone_number_id);
    continue;
  }

  if (existing) {
    const { error } = await supabase
      .from('whatsapp_config')
      .update(payload)
      .eq('id', existing.id);
    if (error) throw error;
    updated += 1;
    console.log('updated', row.display_phone_number);
  } else {
    const { error } = await supabase.from('whatsapp_config').insert(payload);
    if (error) throw error;
    inserted += 1;
    console.log('inserted', row.display_phone_number);
  }
}

await neon.end();
console.log({ dryRun, inserted, updated, lines: toImport.length });
