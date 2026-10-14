// Guarded activation of the existing document-delivery Workers. Does not print secrets.
import fs from 'node:fs';
import {spawn} from 'node:child_process';

const account = 'f8fcf42a91f7fbf1cb89022ead312069';
const scripts = 'https://api.cloudflare.com/client/v4/accounts/'+account+'/workers/scripts/';
const desk = 'architech-wacrm';
const consumer = 'architech-admin-document-consumer';
const expected = {
  [desk]: '027a5e3c-b515-4ed5-b66a-07b4fce7ced5',
  [consumer]: '3af089cf-692c-46de-b9b3-a65d02b3b59f',
};
const flags = {
  [desk]: ['ENABLE_ADMIN_DOCUMENT_DELIVERY','ENABLE_ADMIN_DOCUMENT_QUEUE'],
  [consumer]: ['ENABLE_ADMIN_DOCUMENT_QUEUE_CONSUMER'],
};
const token = fs.readFileSync('C:/Users/amitk/AppData/Roaming/xdg.config/.wrangler/config/default.toml','utf8')
  .match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
if (!token) throw new Error('Cloudflare authorization unavailable');

async function read(name,path) {
  const r = await fetch(scripts+name+path,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30_000)});
  const j = await r.json();
  if (!r.ok || !j.success) throw new Error('Cloudflare inventory unavailable');
  return j.result;
}
function hasFlag(settings,name,value) {
  return settings.bindings.some(b=>b.name===name&&b.type==='plain_text'&&b.text===value);
}
async function check(name,version,value) {
  const deployment = await read(name,'/deployments');
  const versions = deployment.deployments[0]?.versions;
  if (versions?.length!==1 || versions[0].version_id!==version || versions[0].percentage!==100) {
    throw new Error(name+' production version drift; stopped');
  }
  const settings=await read(name,'/settings');
  if (!flags[name].every(flag=>hasFlag(settings,flag,value))) throw new Error(name+' gate drift; stopped');
  return settings;
}
function compareBindings(name,before,after) {
  for (const old of before.bindings) {
    const current=after.bindings.find(b=>b.name===old.name&&b.type===old.type);
    if (!current) throw new Error(name+' lost binding '+old.name);
    if (old.type==='plain_text'&&!flags[name].includes(old.name)&&current.text!==old.text) {
      throw new Error(name+' unrelated binding changed: '+old.name);
    }
    for (const field of ['queue_name','service','bucket_name']) {
      if (old[field]!==undefined&&old[field]!==current[field]) throw new Error(name+' binding target changed: '+old.name);
    }
  }
  if (!flags[name].every(flag=>hasFlag(after,flag,'true'))) throw new Error(name+' activation not applied');
}
async function smoke(path) {
  const r=await fetch('https://whatsapp.architechlabs.in'+path,{redirect:'manual',signal:AbortSignal.timeout(30_000)});
  const result={status:r.status,location:r.headers.get('location')};
  await r.body?.cancel();
  return result;
}
async function command(args,protectedValues) {
  const child=spawn(process.platform==='win32'?'npx.cmd':'npx',args,{
    windowsHide:true,env:{...process.env,OPEN_NEXT_DEPLOY:'true',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false'},stdio:['ignore','pipe','pipe'],shell:process.platform==='win32',
  });
  const redact=line=>protectedValues.reduce((s,v)=>s.split(v).join('[REDACTED]'),line);
  for (const stream of [child.stdout,child.stderr]) {
    let pending='';
    stream.on('data',chunk=>{pending+=chunk.toString();const lines=pending.split('\n');pending=lines.pop();for(const line of lines) console.log(redact(line));});
    stream.on('end',()=>{if(pending) console.log(redact(pending));});
  }
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  if (code!==0) throw new Error('Worker deployment failed');
}
async function main() {
  const mode=process.argv[2];
  if (!['consumer','desk'].includes(mode)) throw new Error('Select consumer or desk');
  const name=mode==='consumer'?consumer:desk;
  if (mode==='desk'&&!fs.existsSync('.open-next/worker.js')) throw new Error('Built Desk artifact absent');
  const before=await check(name,expected[name],'false');
  if (mode==='desk') await check(consumer,(await read(consumer,'/deployments')).deployments[0].versions[0].version_id,'true');
  const paths=['/login','/','/inbox','/api/razorpay/webhook'];
  const baseline=await Promise.all(paths.map(smoke));
  if(baseline[0].status!==200||baseline[3].status!==405) throw new Error('Desk baseline failed');
  const protectedValues=[token,...before.bindings.map(b=>b.text).filter(v=>typeof v==='string'&&v.length>3)].sort((a,b)=>b.length-a.length);
  console.log(name+' baseline verified; deploying existing code with document gate ON.');
  if (mode==='consumer') {
    await command(['wrangler','deploy','--config','infra/admin-document-queue.worker.jsonc','--keep-vars','--message','admin-document-consumer-ON-20261014'],protectedValues);
  } else {
    await command(['wrangler','deploy','--keep-vars','--message','admin-document-delivery-ON-20261014'],protectedValues);
  }
  const after=await read(name,'/settings');
  compareBindings(name,before,after);
  for(let i=0;i<paths.length;i++) {
    const current=await smoke(paths[i]);
    if(JSON.stringify(current)!==JSON.stringify(baseline[i])) throw new Error('Desk route regression: '+paths[i]);
  }
  if (mode==='desk') {
    const status=await smoke('/api/v1/document-deliveries');
    if(status.status!==401) throw new Error('Enabled capability authentication smoke failed');
  }
  const version=(await read(name,'/deployments')).deployments[0].versions;
  console.log(JSON.stringify({worker:name,productionVersion:version[0]?.version_id,rollbackVersion:expected[name],bindingsPreserved:true,baselineRoutesPassed:true,documentGate:true}));
}
main().catch(error=>{console.error(error instanceof Error?error.message:'Activation failed');process.exitCode=1;});
