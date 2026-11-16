import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { resolveWhatsAppConfig } from '@/lib/whatsapp/resolve-config';
import { resolveTemplateRow, renderTemplateBody, templateBodyParams } from '@/lib/whatsapp/template-body';

export class ExternalLogError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = new Set(['sent', 'delivered', 'read', 'failed']);
type Input = Record<string, unknown>;

export async function logExternalMessage(db: SupabaseClient, accountId: string, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ExternalLogError('bad_request', 'Each message must be an object', 400);
  const item = raw as Input;
  if (typeof item.to !== 'string' || !/^[1-9]\d{6,14}$/.test(item.to)) throw new ExternalLogError('bad_request', 'to must be E.164 digits including country code', 400);
  if (typeof item.wamid !== 'string' || !/^wamid\.[^\s]{1,500}$/.test(item.wamid)) throw new ExternalLogError('bad_request', 'wamid must be a valid Meta message ID', 400);
  if (item.type !== 'text' && item.type !== 'template') throw new ExternalLogError('bad_request', 'type must be text or template', 400);
  if (item.type === 'text' && (typeof item.text !== 'string' || !item.text.trim())) throw new ExternalLogError('bad_request', 'text is required', 400);
  if (item.type === 'template' && (typeof item.template_name !== 'string' || !item.template_name.trim() || typeof item.language !== 'string' || !item.language.trim())) throw new ExternalLogError('bad_request', 'template_name and language are required', 400);
  if (item.template_params != null && (typeof item.template_params !== 'object' || item.template_params === null)) throw new ExternalLogError('bad_request', 'template_params must be an array or object', 400);
  for (const field of ['whatsapp_config_id', 'broadcast_id'] as const) {
    if (item[field] != null && (typeof item[field] !== 'string' || !uuid.test(item[field]))) throw new ExternalLogError('bad_request', `${field} must be a UUID`, 400);
  }
  const status = item.status ?? 'sent';
  if (typeof status !== 'string' || !statuses.has(status)) throw new ExternalLogError('bad_request', 'Invalid status', 400);
  if (item.error_code != null && (!Number.isInteger(item.error_code) || (item.error_code as number) < 0 || (item.error_code as number) > 2147483647)) throw new ExternalLogError('bad_request', 'error_code must be a non-negative integer', 400);
  if (item.sent_at != null && (typeof item.sent_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(item.sent_at) || !Number.isFinite(Date.parse(item.sent_at)))) throw new ExternalLogError('bad_request', 'sent_at must be an ISO-8601 timestamp with timezone', 400);

  // Resolve duplicates before any contact, conversation, or broadcast writes.
  const { data: found, error: findError } = await db.from('messages')
    .select('id, conversation_id, conversations!inner(account_id)')
    .eq('message_id', item.wamid).eq('conversations.account_id', accountId).limit(1);
  if (findError) throw new ExternalLogError('internal', 'Could not check existing messages', 500);
  if (found?.length) return { message_id: found[0].id, conversation_id: found[0].conversation_id, wamid: item.wamid, duplicate: true };

  const config = await resolveWhatsAppConfig(db, { accountId, configId: item.whatsapp_config_id as string | undefined });
  if (!config) throw new ExternalLogError('not_found', 'WhatsApp number not found', 404);
  if (item.broadcast_id) {
    const { data, error } = await db.from('broadcasts').select('id').eq('id', item.broadcast_id).eq('account_id', accountId).eq('whatsapp_config_id', config.id).maybeSingle();
    if (error) throw new ExternalLogError('internal', 'Could not check broadcast', 500);
    if (!data) throw new ExternalLogError('not_found', 'Broadcast not found for this number', 404);
  }
  let text = item.type === 'text' ? item.text as string : '';
  if (item.type === 'template') {
    if (!config.waba_id) throw new ExternalLogError('template_not_found', 'The selected number has no WABA template catalog', 422);
    const resolved = await resolveTemplateRow(db, accountId, item.template_name as string, item.language as string, config.waba_id);
    if (!resolved.row || resolved.malformed || resolved.row.language?.toLowerCase() !== (item.language as string).toLowerCase()) throw new ExternalLogError('template_not_found', 'Template not found for this WhatsApp number and language', 422);
    const components = (resolved.row as unknown as { meta_components?: { type?: string; text?: string }[] }).meta_components;
    const body = Array.isArray(components) ? components.find(c => c.type?.toUpperCase() === 'BODY')?.text : undefined;
    const params = templateBodyParams(Array.isArray(item.template_params) ? item.template_params : undefined, item.template_params);
    text = renderTemplateBody(body ?? resolved.row.body_text ?? '', params);
  }
  const conversation = await resolveConversationByPhone(db, accountId, item.to, null, null, null, config.id);
  const { data, error } = await db.rpc('log_external_message', {
    p_account_id: accountId, p_config_id: config.id, p_conversation_id: conversation.conversationId,
    p_contact_id: conversation.contactId, p_wamid: item.wamid, p_content_type: item.type,
    p_content_text: text, p_template_name: item.type === 'template' ? item.template_name : null,
    p_status: status, p_sent_at: item.sent_at ?? new Date().toISOString(),
    p_error_code: item.error_code ?? null, p_broadcast_id: item.broadcast_id ?? null,
  });
  if (error || !Array.isArray(data) || data.length !== 1) throw new ExternalLogError('internal', 'Could not record message', 500);
  return { message_id: data[0].message_id, conversation_id: data[0].conversation_id, wamid: item.wamid, duplicate: data[0].duplicate };
}
