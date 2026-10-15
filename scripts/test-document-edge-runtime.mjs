// Real workerd execution with synthetic service bindings only. No deployment,
// credentials, external network calls, customer rows or real WhatsApp messages.
import {build} from 'esbuild';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
const policy={kind:'quotation',name:'quotation_pdf',language:'en_US',metaTemplateId:'123',bodyText:'Dear {{1}}, quotation {{2}}.',fields:['customerName','documentNumber']};
const approved={id:'123',name:policy.name,language:policy.language,status:'APPROVED',category:'UTILITY',components:[{type:'HEADER',format:'DOCUMENT'},{type:'BODY',text:policy.bodyText}]};
const calls=[];
const result=await build({stdin:{contents:`
import {Buffer} from 'node:buffer';
import {DocumentMetaClient} from './src/lib/document-delivery/meta';
import {prepareDocument} from './src/lib/document-delivery/contracts';
import {documentStorageFetch,SupabasePayloadBucket} from './src/lib/document-delivery/supabase-payload-bucket';
import worker from './src/lib/document-delivery/queue-worker';
globalThis.Buffer=Buffer;
export default {async fetch(request,env){
  const modes=[];
  const provider=(input,init)=>{const request=new Request(input,init);modes.push(request.redirect);return env.PROVIDER.fetch(request);};
  const storageFetch=documentStorageFetch(provider);
  const bucket=new SupabasePayloadBucket({storage:{getBucket:async()=>({data:await (await storageFetch('https://synthetic.invalid/bucket')).json(),error:null})}});
  await bucket.verifyPrivate();
  let redirectRejected=false;try{await storageFetch('https://synthetic.invalid/redirect');}catch{redirectRejected=true;}
  const policy=${JSON.stringify(policy)};
  const document=prepareDocument({kind:'quotation',revision:1,documentNumber:'TEST-1',to:'+919876543210',consentConfirmed:true,fields:{customerName:'Synthetic',documentNumber:'TEST-1'},pdfBase64:Buffer.from('%PDF-1.7 fixture').toString('base64')},policy);
  const client=new DocumentMetaClient('789','synthetic-token','987',provider);
  await client.verifyTemplate(policy);
  const mediaId=await client.upload(document);
  const wamid=await client.send(policy,document,mediaId);
  let acked=0,retried=0;const now=Date.now();
  const workerEnv={ENABLE_ADMIN_DOCUMENT_QUEUE_CONSUMER:'true',ADMIN_DOCUMENT_WORKER_TOKEN:'a'.repeat(64),DESK:{fetch(request){modes.push(request.redirect);return env.PROVIDER.fetch(request);}}};
  await worker.queue({messages:[{body:{version:1,accountId:'11111111-1111-4111-8111-111111111111',deliveryId:'22222222-2222-4222-8222-222222222222',fingerprint:'b'.repeat(64),createdAt:now,expiresAt:now+3600000},ack(){acked++},retry(){retried++}}]},workerEnv);
  await worker.scheduled({},workerEnv);
  return Response.json({privateStorage:true,redirectRejected,mediaUploaded:mediaId==='456',templateAccepted:wamid==='wamid.synthetic',acked,retried,cleanup:true,manualRedirects:modes.length===7&&modes.every(mode=>mode==='manual')});
}};`,resolveDir:process.cwd(),sourcefile:'document-edge-smoke.ts',loader:'ts'},bundle:true,write:false,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','import'],external:['node:crypto','node:buffer'],logLevel:'silent'});
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-08-15',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],script:result.outputFiles[0].text,
  serviceBindings:{PROVIDER:async request=>{
    const url=new URL(request.url);calls.push({path:url.pathname,redirect:request.redirect});
    if(url.pathname==='/bucket')return Response.json({public:false,file_size_limit:4054000,allowed_mime_types:['application/octet-stream']});
    if(url.pathname==='/redirect')return new Response(null,{status:302,headers:{Location:'https://never-follow.invalid'}});
    if(url.pathname.endsWith('/message_templates'))return Response.json({data:[approved]});
    if(url.pathname.endsWith('/media'))return Response.json({id:'456'});
    if(url.pathname.endsWith('/messages'))return Response.json({messages:[{id:'wamid.synthetic'}]});
    if(url.pathname.endsWith('/process')||url.pathname.endsWith('/cleanup'))return new Response(null,{status:204});
    throw new Error('Unexpected synthetic request');
  }},
}));
try{
  const response=await mf.dispatchFetch('https://synthetic.test');
  if(!response.ok)throw new Error('Synthetic edge handler failed');
  const data=await response.json();
  if(!data.privateStorage||!data.redirectRejected||!data.mediaUploaded||!data.templateAccepted||data.acked!==1||data.retried!==0||!data.cleanup||!data.manualRedirects||calls.length!==7)throw new Error('Synthetic edge assertions failed');
  console.log(JSON.stringify({mode:'synthetic_workerd_only',...data,requests:calls.length,realMessagesSent:0}));
}finally{await mf.dispose();}
