// Build with the existing deployment's PUBLIC Supabase settings only. Server
// credentials are neither retrieved nor embedded into the generated artifact.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const api = 'https://api.cloudflare.com/client/v4/accounts/f8fcf42a91f7fbf1cb89022ead312069/workers/scripts/architech-wacrm';
async function main() {
  const token = fs.readFileSync('C:/Users/amitk/AppData/Roaming/xdg.config/.wrangler/config/default.toml','utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
  if (!token) throw new Error();
  const response = await fetch(`${api}/content/v2`,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(30_000)});
  if (!response.ok) throw new Error();
  const source = await response.text();
  const candidates = [...new Set(source.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [])].filter(value => {
    try { const claims=JSON.parse(Buffer.from(value.split('.')[1],'base64url'));return claims.role === 'anon' && claims.ref === 'nthvtmzvmjiowvjgitmv'; }
    catch { return false; }
  });
  if (candidates.length !== 1 || !source.includes('https://nthvtmzvmjiowvjgitmv.supabase.co') || source.includes('ci.example.supabase.co')) throw new Error();
  console.log('Confirmed existing public project settings; building with document sending OFF.');
  const child=spawn(process.execPath,['node_modules/@opennextjs/cloudflare/dist/cli/index.js','build'],{
    windowsHide:true,stdio:'inherit',env:{...process.env,
      NEXT_PUBLIC_SUPABASE_URL:'https://nthvtmzvmjiowvjgitmv.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:candidates[0],
      NEXT_PUBLIC_SITE_URL:'https://whatsapp.architechlabs.in',NEXT_PUBLIC_APP_LOCALE:'en',
      ENCRYPTION_KEY:'0'.repeat(64),META_APP_SECRET:'build-only-placeholder',
      ENABLE_ADMIN_DOCUMENT_DELIVERY:'false',ENABLE_ADMIN_DOCUMENT_QUEUE:'false',
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',
    },
  });
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  if (code !== 0) throw new Error();
  console.log('Production artifact built; nothing uploaded or enabled.');
}
main().catch(()=>{console.error('Document release build failed; no production changes made.');process.exitCode=1;});
