import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CONFIG_COLUMNS, readWhatsAppConfig } from './read-whatsapp-config';

function client(data: unknown, error: unknown = null) {
  const query = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
    abortSignal: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(async () => ({ data, error })),
  };
  const from = vi.fn(() => query);
  return { supabase: { from } as unknown as SupabaseClient, query, from };
}

describe('saved WhatsApp settings read', () => {
  it('loads saved metadata without reading secrets or calling Meta', async () => {
    const saved = { id: 'config', phone_number_id: 'test-number', registered_at: null };
    const { supabase, query, from } = client(saved);
    await expect(readWhatsAppConfig(supabase, 'account-a', new AbortController().signal)).resolves.toEqual(saved);
    expect(from).toHaveBeenCalledWith('whatsapp_config');
    expect(query.eq).toHaveBeenCalledWith('account_id', 'account-a');
    expect(query.select).toHaveBeenCalledWith(CONFIG_COLUMNS);
    expect(CONFIG_COLUMNS).not.toMatch(/access_token|verify_token|\*/);
    expect(query.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });
  it('only returns an empty form result for a successful missing-row read', async () => {
    const { supabase } = client(null);
    await expect(readWhatsAppConfig(supabase, 'account-a', new AbortController().signal)).resolves.toBeNull();
  });
  it('does not turn query failure into missing credentials or expose error contents', async () => {
    const { supabase } = client(null, { message: 'sensitive upstream details' });
    await expect(readWhatsAppConfig(supabase, 'account-a', new AbortController().signal))
      .rejects.toThrow('Could not load saved WhatsApp settings. Please retry.');
  });
  it('can retry successfully after a failed read', async () => {
    const { supabase, query } = client(null, { message: 'temporary' });
    await expect(readWhatsAppConfig(supabase, 'account-a', new AbortController().signal)).rejects.toThrow();
    query.maybeSingle.mockResolvedValueOnce({ data: { id: 'saved' }, error: null });
    await expect(readWhatsAppConfig(supabase, 'account-a', new AbortController().signal)).resolves.toEqual({ id: 'saved' });
  });
});
