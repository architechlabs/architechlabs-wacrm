import fs from 'node:fs';

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

const env = loadEnv();
const base = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION || 'v26.0'}`;
const token = env.META_SYSTEM_USER_TOKEN;

async function get(path) {
  const res = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  return { ok: res.ok, json };
}

const probes = [
  '/me?fields=id,name',
  '/me/businesses?fields=id,name',
  `/${env.DEFAULT_WABA_ID}?fields=id,name,phone_numbers{id,display_phone_number,verified_name,is_on_biz_app}`,
  `/${env.META_APP_ID}?fields=id,name`,
];

for (const path of probes) {
  const { ok, json } = await get(path);
  console.log('\n---', path, ok ? 'OK' : 'ERR');
  console.log(JSON.stringify(json, null, 2));
}
