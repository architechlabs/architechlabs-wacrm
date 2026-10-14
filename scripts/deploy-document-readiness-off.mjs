// Reviewed, one-time OFF release. This cannot enable document sending and refuses
// production drift. It preserves all existing secret bindings and plain values.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
const expectedVersion = 'd1b6dfb2-3ff4-4aae-a81a-c110551cc3b2';
const api = 'https://api.cloudflare.com/client/v4/accounts/f8fcf42a91f7fbf1cb89022ead312069/workers/scripts/architech-wacrm';
async function main() {
  if (process.argv[2] !== 'deploy-off') throw new Error('Explicit deploy-off mode required');
  const token=fs.readFileSync('C:/Users/amitk/AppData/Roaming/xdg.config/.wrangler/config/default.toml','utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m)?.[1];
  if (!token || !fs.existsSync('.open-next/worker.js')) throw new Error('Verified artifact/authorization unavailable');
  const read=async path => {
    const response=await fetch(api+path,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(30_000)});
    const body=await response.json();if(!response.ok || !body.success) throw new Error('Cloudflare inventory unavailable');return body.result;
  };
  const off=settings => ['ENABLE_ADMIN_DOCUMENT_DELIVERY','ENABLE_ADMIN_DOCUMENT_QUEUE'].every(name=>settings.bindings?.some(b=>b.name===name&&b.type==='plain_text'&&b.text==='false'));
  const deployments=await read('/deployments');
  const versions=deployments.deployments[0]?.versions;
  if(versions?.length!==1 || versions[0].version_id!==expectedVersion || versions[0].percentage!==100) throw new Error('Production changed; release stopped');
  const before=await read('/settings');if(!off(before)) throw new Error('Production sending is not OFF; release stopped');
  const smoke=async path => {
    const response=await fetch('https://whatsapp.architechlabs.in'+path,{redirect:'manual',signal:AbortSignal.timeout(30_000)});
    const value={status:response.status,location:response.headers.get('location')};await response.body?.cancel();return value;
  };
  const paths=['/login','/','/inbox','/api/razorpay/webhook'];
  const baseline=await Promise.all(paths.map(smoke));
  if(baseline[0].status!==200||baseline[3].status!==405) throw new Error('Baseline smoke failed');
  const protectedValues=[token,...before.bindings.map(b=>b.text).filter(v=>typeof v==='string'&&v.length>3)].sort((a,b)=>b.length-a.length);
  const redact=value=>protectedValues.reduce((out,v)=>out.split(v).join('[REDACTED]'),value);
  console.log('Baseline verified; uploading OFF-only document readiness release.');
  const child=spawn(process.execPath,['node_modules/@opennextjs/cloudflare/dist/cli/index.js','deploy','--','--keep-vars','--message','document-edge-redirect-fix-OFF-20261014'],{
    windowsHide:true,env:{...process.env,OPEN_NEXT_DEPLOY:'true',CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false'},stdio:['ignore','pipe','pipe'],
  });
  for(const stream of [child.stdout,child.stderr]){
    let pending='';stream.on('data',chunk=>{pending+=chunk.toString();const lines=pending.split('\n');pending=lines.pop();for(const line of lines)console.log(redact(line));});
    stream.on('end',()=>{if(pending)console.log(redact(pending));});
  }
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  if(code!==0) throw new Error('OFF release upload failed');
  const after=await read('/settings');
  if(!off(after)||!before.bindings.every(old=>{
    const current=after.bindings.find(b=>b.name===old.name&&b.type===old.type);
    return current&&(old.type!=='plain_text'||current.text===old.text);
  })) throw new Error('Binding preservation failed; review rollback');
  for(let i=0;i<paths.length;i++){
    const current=await smoke(paths[i]);
    if(JSON.stringify(current)!==JSON.stringify(baseline[i])) throw new Error('Baseline regression; review rollback');
  }
  const cap=await fetch('https://whatsapp.architechlabs.in/api/v1/document-deliveries',{signal:AbortSignal.timeout(15_000)});
  const data=await cap.json();if(!cap.ok||data.data?.enabled!==false||data.data?.policies?.length!==0) throw new Error('Disabled capability regression');
  console.log(JSON.stringify({versions:(await read('/deployments')).deployments[0].versions,rollbackVersion:expectedVersion,bindingsPreserved:true,documentSendingEnabled:false,baselineSmokesPassed:true}));
}
main().catch(error=>{console.error(error instanceof Error ? error.message : 'OFF release failed; details suppressed');process.exitCode=1;});
