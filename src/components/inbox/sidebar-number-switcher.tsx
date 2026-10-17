'use client';

import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useWhatsAppNumber } from '@/hooks/use-whatsapp-number';
import { cn } from '@/lib/utils';

function label(row: {
  display_phone_number?: string | null;
  verified_name?: string | null;
  phone_number_id: string;
}) {
  return row.display_phone_number || row.verified_name || row.phone_number_id;
}

/**
 * Connectly-style line picker in the sidebar. Shown when the workspace
 * has more than one WhatsApp number.
 */
export function SidebarNumberSwitcher({ className }: { className?: string }) {
  const t = useTranslations('Header');
  const { numbers, selectedId, selectNumber, ready } = useWhatsAppNumber();

  if (!ready || numbers.length < 2) return null;

  const selected = numbers.find((row) => row.id === selectedId) ?? numbers[0];

  return (
    <div className={cn('border-b border-sidebar-border px-3 py-3', className)}>
      <label className="flex flex-col gap-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('whatsappNumber')}
        </span>
        <div className="relative">
          <select
            aria-label={t('whatsappNumber')}
            className="w-full appearance-none rounded-lg border border-sidebar-border bg-sidebar-accent py-2 pl-3 pr-9 text-sm font-medium text-foreground"
            value={selectedId ?? selected.id}
            onChange={(event) => selectNumber(event.target.value)}
          >
            {numbers.map((row) => (
              <option key={row.id} value={row.id}>
                {label(row)}
                {row.is_default ? ` (${t('defaultNumber')})` : ''}
              </option>
            ))}
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
        </div>
        {selected?.verified_name && selected.display_phone_number ? (
          <p className="truncate text-xs text-muted-foreground">{selected.verified_name}</p>
        ) : null}
      </label>
    </div>
  );
}
