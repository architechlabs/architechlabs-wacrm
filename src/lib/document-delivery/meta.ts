import { DocumentDeliveryError, MAX_DOCUMENT_BYTES, sha256, type DocumentPolicy, type PreparedDocument } from './contracts';

// A separate bounded, no-retry transport. Existing chat/order send behavior is untouched.
const BASE = 'https://graph.facebook.com/v21.0';
async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new DocumentDeliveryError('meta_response_unconfirmed', 502); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65_536) throw new Error();
      chunks.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch { throw new DocumentDeliveryError('meta_response_unconfirmed', 502); }
  finally { await reader.cancel().catch(() => undefined); }
}

export class DocumentMetaClient {
  constructor(private readonly phoneNumberId: string, private readonly token: string, private readonly wabaId: string, private readonly fetcher: typeof fetch = fetch) {
    if (!/^\d{1,40}$/.test(phoneNumberId) || !/^\d{1,40}$/.test(wabaId) || !token) throw new DocumentDeliveryError('whatsapp_not_configured', 503);
  }
  private async request(path: string, init: RequestInit, timeout: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      return await readJson(await this.fetcher(`${BASE}/${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${this.token}` }, redirect: 'error', signal: controller.signal }));
    } catch { throw new DocumentDeliveryError('meta_response_unconfirmed', 502); }
    finally { clearTimeout(timer); }
  }
  async verifyTemplate(policy: DocumentPolicy) {
    // A token may access multiple WABAs: an ID-only lookup cannot prove ownership.
    // Query the configured WABA and match the exact ID/language; never follow paging URLs.
    const query = new URLSearchParams({name:policy.name,fields:'id,name,language,status,category,components',limit:'100'});
    const response = await this.request(`${this.wabaId}/message_templates?${query}`, { method:'GET' }, 5_000);
    const matches = Array.isArray(response.data) ? (response.data as Record<string, unknown>[]).filter(t => t && t.id === policy.metaTemplateId && t.language === policy.language) : [];
    if (matches.length !== 1) throw new DocumentDeliveryError('template_not_verified',409);
    const data = matches[0];
    const components = Array.isArray(data.components) ? data.components as Record<string, unknown>[] : [];
    const header = components.filter(c => c.type === 'HEADER');
    const body = components.filter(c => c.type === 'BODY');
    if (data.id !== policy.metaTemplateId || data.name !== policy.name || data.language !== policy.language || data.status !== 'APPROVED' || data.category !== 'UTILITY' ||
        header.length !== 1 || header[0].format !== 'DOCUMENT' || body.length !== 1 || body[0].text !== policy.bodyText || components.some(c => c.type === 'BUTTONS')) {
      throw new DocumentDeliveryError('template_not_verified', 409);
    }
  }
  async upload(document: PreparedDocument): Promise<string> {
    const form = new FormData();
    form.append('messaging_product','whatsapp');
    form.append('type','application/pdf');
    form.append('file',new Blob([new Uint8Array(document.pdf)], { type:'application/pdf' }),document.filename);
    const data = await this.request(`${this.phoneNumberId}/media`, { method:'POST',body:form },10_000);
    // Match the reviewed Inbox schema so an uploaded ID cannot fail persistence
    // merely because the transport accepted a longer representation.
    if (typeof data.id !== 'string' || !/^\d{1,40}$/.test(data.id)) throw new DocumentDeliveryError('media_upload_unconfirmed',502);
    return data.id;
  }
  async send(policy: DocumentPolicy, document: PreparedDocument, mediaId: string): Promise<string> {
    if (!/^\d{1,40}$/.test(mediaId)) throw new DocumentDeliveryError('media_upload_unconfirmed',502);
    const data = await this.request(`${this.phoneNumberId}/messages`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
      messaging_product:'whatsapp',recipient_type:'individual',to:document.to.slice(1),type:'template',
      template:{ name:policy.name,language:{code:policy.language},components:[
        {type:'header',parameters:[{type:'document',document:{id:mediaId,filename:document.filename}}]},
        {type:'body',parameters:document.parameters.map(text => ({type:'text',text}))},
      ]},
    }) },10_000);
    const messages = data.messages as {id?:unknown}[] | undefined;
    if (!Array.isArray(messages) || messages.length !== 1 || typeof messages[0]?.id !== 'string' || messages[0].id.length > 300 || !messages[0].id.startsWith('wamid.')) throw new DocumentDeliveryError('send_unconfirmed',502);
    return messages[0].id;
  }
  async download(mediaId: string, expectedHash: string): Promise<Uint8Array> {
    if (!/^\d{1,40}$/.test(mediaId)) throw new DocumentDeliveryError('media_unavailable',404);
    const metadata = await this.request(`${mediaId}?phone_number_id=${this.phoneNumberId}`,{method:'GET'},5_000);
    if (typeof metadata.url !== 'string' || metadata.mime_type !== 'application/pdf') throw new DocumentDeliveryError('media_unavailable',404);
    const url = new URL(metadata.url);
    // Never forward the Meta credential to an arbitrary redirect/host.
    if (url.protocol !== 'https:' || url.hostname !== 'lookaside.fbsbx.com' || url.username || url.password || url.port) throw new DocumentDeliveryError('media_unavailable',404);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),10_000);
    try {
      const response = await this.fetcher(url,{headers:{Authorization:`Bearer ${this.token}`},redirect:'error',signal:controller.signal});
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks:Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const {done,value} = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_DOCUMENT_BYTES) throw new Error();
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const bytes = Buffer.concat(chunks);
      if (sha256(bytes) !== expectedHash) throw new Error();
      return new Uint8Array(bytes);
    } catch { throw new DocumentDeliveryError('media_unavailable',404); }
    finally { clearTimeout(timer); }
  }
}
