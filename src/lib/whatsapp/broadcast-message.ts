import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageTemplate } from '@/types';
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation';
import { templateBodyParams, templateContentText } from '@/lib/whatsapp/template-body';

/** Reserve the inbox row before sending, so an accepted send is never invisible
 * just because a later inbox insert fails. */
export async function reserveBroadcastMessage(db: SupabaseClient, args: {
  accountId: string; userId: string; configId: string; broadcastId: string;
  phone: string; templateName: string; template: MessageTemplate | null;
  params: string[]; messageParams?: unknown;
}): Promise<{ id: string; conversationId: string; text: string | null }> {
  const { conversationId } = await resolveConversationByPhone(db, args.accountId, args.phone, null, args.userId, null, args.configId);
  const text = templateContentText(args.template, templateBodyParams(args.params, args.messageParams));
  const { data, error } = await db.from('messages').insert({ conversation_id: conversationId,
    sender_type: 'agent', content_type: 'template', content_text: text,
    template_name: args.templateName, status: 'sending', broadcast_id: args.broadcastId,
  }).select('id').single();
  if (error || !data) throw new Error('Could not reserve broadcast inbox message');
  const now = new Date().toISOString();
  const { error: conversationError } = await db.from('conversations').update({
    last_message_text: text || `[Template: ${args.templateName}]`, last_message_at: now, updated_at: now,
  }).eq('id', conversationId);
  if (conversationError) throw new Error('Could not update broadcast conversation');
  return { id: data.id, conversationId, text };
}

export async function finishBroadcastMessage(db: SupabaseClient, reservation: {
  id: string; conversationId: string; text: string | null;
}, messageId: string, templateName: string): Promise<void> {
  const { error } = await db.from('messages').update({ message_id: messageId, status: 'sent' })
    .eq('id', reservation.id).eq('conversation_id', reservation.conversationId);
  if (error) throw new Error('Could not update broadcast inbox message');
  const now = new Date().toISOString();
  const { error: conversationError } = await db.from('conversations').update({
    last_message_text: reservation.text || `[Template: ${templateName}]`, last_message_at: now, updated_at: now,
  }).eq('id', reservation.conversationId);
  if (conversationError) throw new Error('Could not update broadcast conversation');
}

/** Persist a message already accepted by Meta; this function never sends. */
export async function saveBroadcastMessage(db: SupabaseClient, args: {
  accountId: string;
  userId: string;
  configId: string;
  broadcastId?: string | null;
  phone: string;
  messageId: string;
  templateName: string;
  template: MessageTemplate | null;
  params: string[];
  messageParams?: unknown;
}): Promise<void> {
  const { conversationId } = await resolveConversationByPhone(
    db, args.accountId, args.phone, null, args.userId, null, args.configId,
  );
  const text = templateContentText(args.template, templateBodyParams(args.params, args.messageParams));
  const { error } = await db.from('messages').upsert({
    conversation_id: conversationId,
    sender_type: 'agent',
    content_type: 'template',
    content_text: text,
    template_name: args.templateName,
    message_id: args.messageId,
    status: 'sent',
    broadcast_id: args.broadcastId ?? null,
  }, { onConflict: 'conversation_id,message_id', ignoreDuplicates: true });
  if (error) throw new Error(`Could not save broadcast message: ${error.message}`);
  const now = new Date().toISOString();
  const { error: conversationError } = await db.from('conversations').update({
    last_message_text: text || `[Template: ${args.templateName}]`,
    last_message_at: now,
    updated_at: now,
  }).eq('id', conversationId);
  if (conversationError) throw new Error(`Could not update broadcast conversation: ${conversationError.message}`);
}
