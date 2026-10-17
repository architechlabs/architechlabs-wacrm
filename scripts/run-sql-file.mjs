import fs from 'node:fs';

const PROJECT_REF = 'nthvtmzvmjiowvjgitmv';
const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/run-sql-file.mjs <path.sql>');
  process.exit(1);
}

let token = process.env.SUPABASE_ACCESS_TOKEN ?? '';
if (!token) {
  for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^SUPABASE_ACCESS_TOKEN=(.*)$/);
    if (m) token = m[1].trim();
  }
}
if (!token) throw new Error('SUPABASE_ACCESS_TOKEN required');

const query = fs.readFileSync(file, 'utf8');
const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query }),
});
const body = await res.text();
if (!res.ok) {
  console.error(body.slice(0, 2000));
  process.exit(1);
}
console.log('OK');
