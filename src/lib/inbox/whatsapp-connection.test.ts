import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readWhatsappConnectionStatus } from './whatsapp-connection';

describe('readWhatsappConnectionStatus', () => {
  it('uses only the AuthProvider account id for the tenant-scoped lookup', async () => {
    const maybeSingle = vi.fn(async () => ({
      data: { status: 'connected' },
      error: null,
    }));
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
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
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient;

    await expect(
      readWhatsappConnectionStatus(supabase, 'account-a')
    ).resolves.toBe(false);
  });
});
