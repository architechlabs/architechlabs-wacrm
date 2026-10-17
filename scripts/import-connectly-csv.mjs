/**
 * Import Connectly export CSVs into Supabase (contacts, conversations, messages).
 *
 *   node scripts/import-connectly-csv.mjs [--dry-run]
 *
 * Expects resources/business_accounts.csv, chats.csv, messages.csv
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const ARCHITECH_ACCOUNT_ID = '90e47f37-19d5-4fb8-94f8-8c2df7599f7e';
const dryRun = process.argv.includes('--dry-run');
const ROOT = process.cwd();

const ALLOWED_TYPES = new Set([
  'text', 'image', 'document', 'audio', 'video', 'location', 'template',
  'interactive', 'unsupported', 'sticker',
]);

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

/** Minimal RFC 4180 parser (handles quoted fields and multiline cells). */
function parseCsv(text) {
  const records = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || (c === '\r' && text[i + 1] === '\n')) {
      if (c === '\r') i++;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.length > 0)) records.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  return records;
}

function readCsvObjects(filename) {
  const filePath = path.join(ROOT, 'resources', filename);
  const raw = fs.readFileSync(filePath, 'utf8');
  const rows = parseCsv(raw);
  const [header, ...body] = rows;
  return body.map((cells) => {
    const obj = {};
    header.forEach((key, idx) => {
      obj[key] = cells[idx] ?? '';
    });
    return obj;
  });
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function mapContentType(type) {
  const t = (type || 'text').toLowerCase();
  if (t === 'revoke') return null;
  if (ALLOWED_TYPES.has(t)) return t;
  if (t === 'reaction') return 'text';
  return 'unsupported';
}

function mapStatus(direction, status) {
  if (direction === 'inbound') return 'delivered';
  const s = (status || '').toLowerCase();
  if (s === 'read') return 'read';
  if (s === 'delivered') return 'delivered';
  if (s === 'failed') return 'failed';
  return 'sent';
}

function wacrmEncrypt(text, hexKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}:${cipher.getAuthTag().toString('hex')}`;
}

const env = loadEnv();
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: configRows, error: configErr } = await supabase
  .from('whatsapp_config')
  .select('id, phone_number_id, user_id, is_default')
  .eq('account_id', ARCHITECH_ACCOUNT_ID);
if (configErr) throw configErr;

const configByPhone = new Map(configRows.map((row) => [row.phone_number_id, row]));
const ownerUserId = configRows[0]?.user_id;
if (!ownerUserId) {
  console.error('No whatsapp_config rows for Architech account.');
  process.exit(1);
}

const businessRows = readCsvObjects('business_accounts.csv');
const chatRows = readCsvObjects('chats.csv');
const messageRows = readCsvObjects('messages.csv');

const chatPhoneIds = new Set(chatRows.map((c) => c.phone_number_id).filter(Boolean));
const businessByPhone = new Map(
  businessRows.filter((r) => r.phone_number_id).map((r) => [r.phone_number_id, r]),
);

const token = env.META_SYSTEM_USER_TOKEN?.trim();
const encryptedToken = token ? wacrmEncrypt(token, env.ENCRYPTION_KEY) : null;
const encryptedVerify = env.META_WEBHOOK_VERIFY_TOKEN
  ? wacrmEncrypt(env.META_WEBHOOK_VERIFY_TOKEN, env.ENCRYPTION_KEY)
  : null;
const now = new Date().toISOString();

for (const phoneNumberId of chatPhoneIds) {
  if (configByPhone.has(phoneNumberId)) continue;
  const row = businessByPhone.get(phoneNumberId);
  if (!row?.waba_id || !encryptedToken) {
    console.warn('Cannot create whatsapp_config for', phoneNumberId);
    continue;
  }
  if (dryRun) {
    console.log('would create whatsapp_config for', row.display_phone_number);
    configByPhone.set(phoneNumberId, { id: `dry-${phoneNumberId}`, phone_number_id: phoneNumberId, user_id: ownerUserId });
    continue;
  }
  const { data: created, error } = await supabase
    .from('whatsapp_config')
    .insert({
      account_id: ARCHITECH_ACCOUNT_ID,
      user_id: ownerUserId,
      phone_number_id: phoneNumberId,
      waba_id: row.waba_id,
      display_phone_number: row.display_phone_number || null,
      verified_name: row.name || null,
      is_on_biz_app: row.is_on_biz_app === 'true',
      is_default: false,
      source: 'manual',
      access_token: encryptedToken,
      verify_token: encryptedVerify,
      status: (row.status || '').toUpperCase() === 'CONNECTED' ? 'connected' : 'connected',
      connected_at: now,
      subscribed_apps_at: now,
      updated_at: now,
    })
    .select('id, phone_number_id, user_id, is_default')
    .single();
  if (error) throw error;
  configByPhone.set(phoneNumberId, created);
  console.log('created whatsapp_config for', row.display_phone_number);
}

const chatIdToConversation = new Map();
let contactsCreated = 0;
let conversationsCreated = 0;
let messagesInserted = 0;
let messagesSkipped = 0;

for (const chat of chatRows) {
  const phoneNumberId = chat.phone_number_id;
  const config = configByPhone.get(phoneNumberId);
  if (!config) {
    console.warn('Skip chat', chat.id, '— unknown phone_number_id', phoneNumberId);
    continue;
  }

  const waId = normalizePhone(chat.wa_id);
  if (!waId) {
    console.warn('Skip chat', chat.id, '— empty wa_id');
    continue;
  }

  const phone = chat.wa_id.startsWith('+') ? chat.wa_id : waId;
  const contactName = chat.name?.trim() || null;

  let contactId;
  const { data: existingContacts } = await supabase
    .from('contacts')
    .select('id, name')
    .eq('account_id', ARCHITECH_ACCOUNT_ID)
    .eq('whatsapp_config_id', config.id)
    .eq('phone_normalized', waId)
    .limit(1);

  if (existingContacts?.[0]) {
    contactId = existingContacts[0].id;
    if (contactName && contactName !== existingContacts[0].name && !dryRun) {
      await supabase.from('contacts').update({ name: contactName }).eq('id', contactId);
    }
  } else if (dryRun) {
    contactId = `dry-contact-${chat.id}`;
    contactsCreated += 1;
  } else {
    const { data: created, error } = await supabase
      .from('contacts')
      .insert({
        account_id: ARCHITECH_ACCOUNT_ID,
        user_id: ownerUserId,
        phone,
        name: contactName || phone,
        whatsapp_config_id: config.id,
      })
      .select('id')
      .single();
    if (error) throw error;
    contactId = created.id;
    contactsCreated += 1;
  }

  let conversationId;
  const { data: existingConvs } = await supabase
    .from('conversations')
    .select('id')
    .eq('account_id', ARCHITECH_ACCOUNT_ID)
    .eq('contact_id', contactId)
    .eq('whatsapp_config_id', config.id)
    .order('created_at', { ascending: true })
    .limit(1);

  if (existingConvs?.[0]) {
    conversationId = existingConvs[0].id;
  } else if (dryRun) {
    conversationId = `dry-conv-${chat.id}`;
    conversationsCreated += 1;
  } else {
    const { data: created, error } = await supabase
      .from('conversations')
      .insert({
        account_id: ARCHITECH_ACCOUNT_ID,
        user_id: ownerUserId,
        contact_id: contactId,
        whatsapp_config_id: config.id,
        status: 'open',
      })
      .select('id')
      .single();
    if (error) throw error;
    conversationId = created.id;
    conversationsCreated += 1;
  }

  chatIdToConversation.set(String(chat.id), conversationId);

  const unread = Number.parseInt(chat.unread_count || '0', 10) || 0;
  const lastAt = chat.last_message_at || null;
  if (!dryRun && (unread > 0 || lastAt)) {
    await supabase
      .from('conversations')
      .update({
        unread_count: unread,
        last_message_at: lastAt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversationId);
  }
}

for (const msg of messageRows) {
  const conversationId = chatIdToConversation.get(String(msg.chat_id));
  if (!conversationId || conversationId.startsWith('dry-')) continue;

  const contentType = mapContentType(msg.type);
  if (!contentType) {
    messagesSkipped += 1;
    continue;
  }

  const direction = msg.direction === 'outbound' ? 'outbound' : 'inbound';
  const senderType = direction === 'inbound' ? 'customer' : 'agent';
  const body = (msg.body || '').trim();
  const contentText =
    contentType === 'text' && (msg.type || '').toLowerCase() === 'reaction'
      ? body || '👍'
      : body || (contentType === 'unsupported' ? 'Unsupported message' : null);

  const payload = {
    conversation_id: conversationId,
    sender_type: senderType,
    content_type: contentType,
    content_text: contentText,
    message_id: msg.wa_message_id,
    status: mapStatus(direction, msg.status),
    created_at: msg.sent_at || msg.created_at,
  };

  if (dryRun) {
    messagesInserted += 1;
    continue;
  }

  const { error } = await supabase.from('messages').upsert(payload, {
    onConflict: 'conversation_id,message_id',
    ignoreDuplicates: true,
  });
  if (error) {
    console.warn('Message insert failed', msg.wa_message_id, error.message);
    messagesSkipped += 1;
    continue;
  }
  messagesInserted += 1;
}

// Refresh last_message_text from latest imported message per conversation.
if (!dryRun) {
  for (const conversationId of chatIdToConversation.values()) {
    if (conversationId.startsWith('dry-')) continue;
    const { data: latest } = await supabase
      .from('messages')
      .select('content_text, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest?.content_text) {
      await supabase
        .from('conversations')
        .update({
          last_message_text: latest.content_text.slice(0, 500),
          last_message_at: latest.created_at,
        })
        .eq('id', conversationId);
    }
  }
}

console.log({
  dryRun,
  chats: chatRows.length,
  messagesInCsv: messageRows.length,
  contactsCreated,
  conversationsCreated,
  messagesInserted,
  messagesSkipped,
  mappedChats: chatIdToConversation.size,
});
