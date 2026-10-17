'use client';

import { useTranslations } from 'next-intl';
import { useWhatsAppNumber } from '@/hooks/use-whatsapp-number';

function label(row: { display_phone_number?: string | null; verified_name?: string | null; phone_number_id: string }) {
  return row.display_phone_number || row.verified_name || row.phone_number_id;
}

export function NumberSwitcher() {
  const t = useTranslations('Header');
  const { numbers, selectedId, selectNumber, ready } = useWhatsAppNumber();
  if (!ready || numbers.length < 2) return null;

  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="sr-only">{t('whatsappNumber')}</span>
      <select
        aria-label={t('whatsappNumber')}
        className="h-9 max-w-52 truncate rounded-md border border-border bg-background px-2 text-sm text-foreground"
        value={selectedId ?? ''}
        onChange={(event) => selectNumber(event.target.value)}
      >
        {numbers.map((row) => (
          <option key={row.id} value={row.id}>
            {label(row)}{row.is_default ? ` (${t('defaultNumber')})` : ''}
          </option>
        ))}
      </select>
    </label>
  );
}
