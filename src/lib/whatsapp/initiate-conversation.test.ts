import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  send: vi.fn(),
}));

vi.mock('./resolve-conversation', () => ({
  resolveConversationByPhone: (...args: unknown[]) => mocks.resolve(...args),
}));

vi.mock('./send-message', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendMessageToConversation: (...args: unknown[]) => mocks.send(...args),
}));

import {
  initiateConversationWithTemplate,
  type InitiateConversationParams,
} from './initiate-conversation';
import { SendMessageError } from './send-message';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONTACT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TEMPLATE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REQUEST_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const APPROVED_TEMPLATE = {
  id: TEMPLATE_ID,
  user_id: USER_ID,
  account_id: ACCOUNT_ID,
  name: 'order_update',
  category: 'Utility',
  language: 'en',
  body_text: 'Hello {{1}}, order {{2}} is ready.',
  status: 'APPROVED',
  meta_template_id: 'meta-template-1',
  created_at: '2026-01-01T00:00:00.000Z',
};

interface MessageRow extends Record<string, unknown> {
  id: string;
  status: string;
  message_id: string | null;
  client_request_id: string;
  conversation_id: string;
}

function makeDb(
  options: {
    template?: Record<string, unknown> | null;
    contact?: Record<string, unknown> | null;
  } = {}
) {
  const rows: MessageRow[] = [];
  const template =
    options.template === undefined ? APPROVED_TEMPLATE : options.template;
  const contact =
    options.contact === undefined
      ? { id: CONTACT_ID, phone: '+15551234567' }
      : options.contact;

  function builder(table: string) {
    let operation: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let payload: Record<string, unknown> = {};
    const filters: Record<string, unknown> = {};

    const result = () => {
      if (table === 'message_templates') {
        const templateRecord = template as Record<string, unknown> | null;
        const matches =
          templateRecord &&
          Object.entries(filters).every(
            ([key, value]) => templateRecord[key] === value
          );
        return { data: matches ? templateRecord : null, error: null };
      }
      if (table === 'contacts') return { data: contact, error: null };
      if (table !== 'messages') return { data: null, error: null };

      if (operation === 'insert') {
        const duplicate = rows.find(
          (row) =>
            row.conversation_id === payload.conversation_id &&
            row.client_request_id === payload.client_request_id
        );
        if (duplicate) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key' },
          };
        }
        const row = {
          ...payload,
          id: `message-${rows.length + 1}`,
          status: String(payload.status),
          message_id: (payload.message_id as string | null) ?? null,
        } as MessageRow;
        rows.push(row);
        return { data: row, error: null };
      }

      if (operation === 'update') {
        const row = rows.find((candidate) =>
          Object.entries(filters).every(
            ([key, value]) => candidate[key] === value
          )
        );
        if (!row) return { data: null, error: null };
        Object.assign(row, payload);
        return { data: row, error: null };
      }

      const row = rows.find((candidate) =>
        Object.entries(filters).every(
          ([key, value]) => candidate[key] === value
        )
      );
      return { data: row ?? null, error: null };
    };

    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((key: string, value: unknown) => {
      filters[key] = value;
      return chain;
    });
    chain.order = vi.fn(() => chain);
    chain.gt = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.insert = vi.fn((value: Record<string, unknown>) => {
      operation = 'insert';
      payload = value;
      return chain;
    });
    chain.update = vi.fn((value: Record<string, unknown>) => {
      operation = 'update';
      payload = value;
      return chain;
    });
    chain.delete = vi.fn(() => {
      operation = 'delete';
      return chain;
    });
    chain.single = vi.fn(async () => result());
    chain.maybeSingle = vi.fn(async () => result());
    return chain;
  }

  return {
    db: {
      from: vi.fn((table: string) => builder(table)),
    } as unknown as SupabaseClient,
    rows,
  };
}

function baseInput(overrides: Partial<InitiateConversationParams> = {}) {
  return {
    accountId: ACCOUNT_ID,
    userId: USER_ID,
    contactId: CONTACT_ID,
    templateId: TEMPLATE_ID,
    clientRequestId: REQUEST_ID,
    templateMessageParams: { body: ['Ada', '#123'] },
    ...overrides,
  } satisfies InitiateConversationParams;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({
    conversationId: 'conversation-1',
    contactId: CONTACT_ID,
    contactCreated: false,
    conversationCreated: false,
  });
  mocks.send.mockResolvedValue({
    messageId: 'message-1',
    whatsappMessageId: 'wamid.1',
  });
});

describe('initiateConversationWithTemplate', () => {
  it('sends an approved template to an existing contact', async () => {
    const { db, rows } = makeDb();
    const result = await initiateConversationWithTemplate(db, baseInput());

    expect(mocks.resolve).toHaveBeenCalledWith(
      db,
      ACCOUNT_ID,
      '+15551234567',
      null,
      USER_ID,
      CONTACT_ID
    );
    expect(mocks.send).toHaveBeenCalledWith(
      db,
      ACCOUNT_ID,
      expect.objectContaining({
        messageType: 'template',
        templateName: 'order_update',
        reservedMessageId: 'message-1',
      })
    );
    expect(rows[0]).toMatchObject({
      sender_type: 'agent',
      content_type: 'template',
      status: 'sending',
      client_request_id: REQUEST_ID,
    });
    expect(result.whatsappMessageId).toBe('wamid.1');
  });

  it('passes a normalized new-contact target into the shared resolver', async () => {
    const { db } = makeDb();
    mocks.resolve.mockResolvedValue({
      conversationId: 'conversation-new',
      contactId: 'contact-new',
      contactCreated: true,
      conversationCreated: true,
    });

    const result = await initiateConversationWithTemplate(
      db,
      baseInput({
        contactId: null,
        phone: '+1 (555) 123-4567',
        name: 'New Customer',
      })
    );

    expect(mocks.resolve).toHaveBeenCalledWith(
      db,
      ACCOUNT_ID,
      '+1 (555) 123-4567',
      'New Customer',
      USER_ID,
      null
    );
    expect(result).toMatchObject({
      contactCreated: true,
      conversationCreated: true,
    });
  });

  it('rejects an invalid new phone before a Meta send', async () => {
    const { db } = makeDb();
    mocks.resolve.mockRejectedValue(
      new SendMessageError('bad_request', 'Invalid phone number format', 400)
    );

    await expect(
      initiateConversationWithTemplate(
        db,
        baseInput({ contactId: null, phone: '09876', name: 'Bad Number' })
      )
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous target containing both contact and phone', async () => {
    const { db } = makeDb();
    await expect(
      initiateConversationWithTemplate(db, baseInput({ phone: '+15551234567' }))
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('fails closed when WhatsApp configuration is missing', async () => {
    const { db } = makeDb();
    mocks.resolve.mockRejectedValue(
      new SendMessageError(
        'whatsapp_not_configured',
        'WhatsApp not configured',
        400
      )
    );

    await expect(
      initiateConversationWithTemplate(db, baseInput())
    ).rejects.toMatchObject({ code: 'whatsapp_not_configured' });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not send a rejected, pending, missing, or unsynced template', async () => {
    for (const unusable of [
      null,
      { ...APPROVED_TEMPLATE, status: 'PENDING' },
      { ...APPROVED_TEMPLATE, status: 'REJECTED' },
      { ...APPROVED_TEMPLATE, meta_template_id: null },
    ]) {
      const { db } = makeDb({ template: unusable });
      await expect(
        initiateConversationWithTemplate(db, baseInput())
      ).rejects.toMatchObject({ code: 'no_approved_template', status: 400 });
    }
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('rejects missing template variables before creating a contact/conversation', async () => {
    const { db, rows } = makeDb();
    await expect(
      initiateConversationWithTemplate(
        db,
        baseInput({ templateMessageParams: { body: ['Ada', ''] } })
      )
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it('propagates a Meta rejection without representing the message as sent', async () => {
    const { db, rows } = makeDb();
    mocks.send.mockRejectedValue(
      new SendMessageError('meta_error', 'Meta API error', 502)
    );

    await expect(
      initiateConversationWithTemplate(db, baseInput())
    ).rejects.toMatchObject({ code: 'meta_error', status: 502 });
    expect(rows[0]).toMatchObject({ status: 'sending', message_id: null });
  });

  it('returns contact/conversation creation flags and the Meta message id', async () => {
    const { db } = makeDb();
    mocks.resolve.mockResolvedValue({
      conversationId: 'conversation-new',
      contactId: 'contact-new',
      contactCreated: true,
      conversationCreated: true,
    });
    const result = await initiateConversationWithTemplate(
      db,
      baseInput({ contactId: null, phone: '+15551234567', name: 'Ada' })
    );
    expect(result).toMatchObject({
      messageId: 'message-1',
      whatsappMessageId: 'wamid.1',
      contactCreated: true,
      conversationCreated: true,
      deduplicated: false,
    });
  });

  it('deduplicates a repeated completed request without another Meta call', async () => {
    const { db, rows } = makeDb();
    await initiateConversationWithTemplate(db, baseInput());
    rows[0].status = 'sent';
    rows[0].message_id = 'wamid.1';

    const repeated = await initiateConversationWithTemplate(db, baseInput());

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(repeated).toMatchObject({
      deduplicated: true,
      messageId: 'message-1',
      whatsappMessageId: 'wamid.1',
    });
  });

  it('returns 409 semantics while the original request is still sending', async () => {
    const { db } = makeDb();
    await initiateConversationWithTemplate(db, baseInput());

    await expect(
      initiateConversationWithTemplate(db, baseInput())
    ).rejects.toMatchObject({ code: 'duplicate_in_progress', status: 409 });
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it('reuses a failed reservation for an explicit safe retry', async () => {
    const { db, rows } = makeDb();
    mocks.send.mockRejectedValueOnce(
      new SendMessageError('meta_error', 'Meta rejected request', 502)
    );
    await expect(
      initiateConversationWithTemplate(db, baseInput())
    ).rejects.toMatchObject({ code: 'meta_error' });
    rows[0].status = 'failed';

    const retried = await initiateConversationWithTemplate(db, baseInput());

    expect(rows).toHaveLength(1);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(retried.whatsappMessageId).toBe('wamid.1');
  });

  it('requires acknowledgement before a fresh resend after recorded 131049', async () => {
    const { db, rows } = makeDb();
    await initiateConversationWithTemplate(db, baseInput());
    rows[0].status = 'failed';
    rows[0].message_id = 'wamid.failed';
    rows[0].failure_code = 131049;
    rows[0].created_at = '2026-08-18T10:00:00.000Z';

    await expect(
      initiateConversationWithTemplate(
        db,
        baseInput({ clientRequestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })
      )
    ).rejects.toMatchObject({
      code: 'retry_acknowledgement_required',
      status: 409,
    });

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
  });

  it('allows an explicitly acknowledged later retry without requiring inbound', async () => {
    const { db, rows } = makeDb();
    await initiateConversationWithTemplate(db, baseInput());
    rows[0].status = 'failed';
    rows[0].message_id = 'wamid.failed';
    rows[0].failure_code = 131049;
    rows[0].created_at = '2026-08-18T10:00:00.000Z';

    const retried = await initiateConversationWithTemplate(
      db,
      baseInput({
        clientRequestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        acknowledgeRecipientRestriction: true,
      })
    );

    expect(retried.deduplicated).toBe(false);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
  });

  it('allows only one Meta call for concurrent acknowledged duplicate requests', async () => {
    const { db, rows } = makeDb();
    await initiateConversationWithTemplate(db, baseInput());
    rows[0].status = 'failed';
    rows[0].message_id = 'wamid.failed';
    rows[0].failure_code = 131049;
    rows[0].created_at = '2026-08-18T10:00:00.000Z';
    mocks.send.mockClear();

    const retryInput = baseInput({
      clientRequestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      acknowledgeRecipientRestriction: true,
    });
    const results = await Promise.allSettled([
      initiateConversationWithTemplate(db, retryInput),
      initiateConversationWithTemplate(db, retryInput),
    ]);

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
  });

  it('leaves a successfully delivered recipient unaffected', async () => {
    const { db, rows } = makeDb();
    await initiateConversationWithTemplate(db, baseInput());
    rows[0].status = 'delivered';
    rows[0].message_id = 'wamid.delivered';

    await initiateConversationWithTemplate(
      db,
      baseInput({ clientRequestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' })
    );

    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(2);
  });
});
