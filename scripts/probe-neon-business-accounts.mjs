import fs from 'node:fs';
import postgres from 'postgres';

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

const { DATABASE_URL, CONNECTLY_DATABASE_URL } = loadEnv();
const dbUrl = DATABASE_URL || CONNECTLY_DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL or CONNECTLY_DATABASE_URL missing');
  process.exit(1);
}

const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
const rows = await sql`
  select id, waba_id, phone_number_id, display_phone_number, name, status,
         is_default, is_on_biz_app, subscribed,
         access_token is not null as has_token,
         pg_typeof(access_token) as token_type
  from business_accounts
  order by id
`;
console.log(rows);
const sample = await sql`
  select id, access_token
  from business_accounts
  where access_token is not null and phone_number_id is not null and status = 'CONNECTED'
  limit 1
`;
if (sample[0]) {
  console.log('sample token keys:', Object.keys(sample[0].access_token ?? {}));
  console.log('sample token:', JSON.stringify(sample[0].access_token).slice(0, 200));
}
await sql.end();
