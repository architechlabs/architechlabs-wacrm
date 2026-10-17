import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readWhatsappConnectionStatus } from './whatsapp-connection';

describe('readWhatsappConnectionStatus', () => {
  it('uses only the AuthProvider account id for the tenant-scoped lookup', async () => {
    const maybeSingle = vi.fn(async () => ({
      data: { status: 'connected' },
      error: null,
    }));
    const chain = {
      eq: vi.fn(),
      abortSignal: vi.fn(() => ({ maybeSingle })),
    };
    chain.eq.mockReturnValue(chain);
    const select = vi.fn(() => chain);
    const from = vi.fn(() => ({ select }));
    const eq = chain.eq;
    const supabase = { from } as unknown as SupabaseClient;

    await expect(
      readWhatsappConnectionStatus(supabase, 'account-a')
    ).resolves.toBe(true);
    expect(from).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith('whatsapp_config');
    expect(select).toHaveBeenCalledWith('status');
    expect(eq).toHaveBeenCalledWith('account_id', 'account-a');
  });

  it('treats a missing or non-connected row as disconnected', async () => {
    const chain = {
      eq: () => chain,
      abortSignal: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
    };
    const supabase = {
      from: () => ({ select: () => chain }),
    } as unknown as SupabaseClient;

    await expect(
      readWhatsappConnectionStatus(supabase, 'account-a')
    ).resolves.toBe(false);
  });

  it('does not misreport a database error as disconnected credentials', async () => {
    const query = {
      select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(),
      abortSignal: vi.fn().mockReturnThis(),
      maybeSingle: async () => ({ data: null, error: { message: 'database unavailable' } }),
    };
    const supabase = { from: () => query } as unknown as SupabaseClient;
    await expect(readWhatsappConnectionStatus(supabase, 'account-a')).rejects.toThrow('WhatsApp connection status unavailable');
  });
});
