'use client';

import { Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useWhatsAppNumber } from '@/hooks/use-whatsapp-number';
import type { SavedWhatsAppConfig } from '@/lib/settings/read-whatsapp-config';
import { cn } from '@/lib/utils';

function lineTitle(row: SavedWhatsAppConfig) {
  return row.display_phone_number || row.verified_name || row.phone_number_id;
}

function lineSubtitle(row: SavedWhatsAppConfig) {
  if (row.verified_name && row.display_phone_number) return row.verified_name;
  if (row.verified_name && !row.display_phone_number) return null;
  return row.waba_id ? `WABA ${row.waba_id.slice(-6)}` : null;
}

type Variant = 'sidebar' | 'compact';

export function WhatsAppNumberSelect({ variant = 'sidebar' }: { variant?: Variant }) {
  const t = useTranslations('Header');
  const { numbers, selectedId, selectNumber, ready } = useWhatsAppNumber();

  if (!ready || numbers.length < 2) return null;

  const value = selectedId ?? numbers[0]?.id ?? '';
  const selected = numbers.find((row) => row.id === value) ?? numbers[0];
  const compact = variant === 'compact';

  return (
    <div
      className={cn(
        compact ? 'min-w-0 max-w-[min(100%,14rem)]' : 'border-b border-sidebar-border px-3 py-3',
      )}
    >
      {!compact ? (
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('whatsappNumber')}
        </p>
      ) : null}

      <Select
        value={value}
        onValueChange={(id) => {
          if (id) selectNumber(id);
        }}
      >
        <SelectTrigger
          aria-label={t('whatsappNumber')}
          className={cn(
            'w-full gap-2 border-border bg-card text-left shadow-none',
            compact
              ? 'h-9 max-w-full bg-background px-2.5 data-[size=default]:h-9'
              : 'h-auto min-h-10 rounded-xl border-sidebar-border bg-sidebar-accent/80 px-3 py-2.5 hover:bg-sidebar-accent data-[size=default]:h-auto',
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-2.5">
            <span
              className={cn(
                'flex shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary',
                compact ? 'size-7' : 'size-9',
              )}
            >
              <Phone className={compact ? 'size-3.5' : 'size-4'} aria-hidden />
            </span>
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-sm font-medium leading-tight text-foreground">
                <SelectValue placeholder={lineTitle(selected)} />
              </span>
              {!compact && lineSubtitle(selected) ? (
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {lineSubtitle(selected)}
                </span>
              ) : null}
            </span>
            {selected?.status === 'connected' ? (
              <span
                className="size-2 shrink-0 rounded-full bg-emerald-500 ring-2 ring-emerald-500/25"
                title="Connected"
                aria-hidden
              />
            ) : null}
          </span>
        </SelectTrigger>

        <SelectContent
          className="z-[100] max-h-72 w-[var(--anchor-width)] min-w-[16rem] border-border bg-popover p-1"
          side={compact ? 'bottom' : 'bottom'}
          align={compact ? 'end' : 'start'}
          sideOffset={6}
        >
          {numbers.map((row) => {
            const title = lineTitle(row);
            const subtitle = lineSubtitle(row);
            const label = row.is_default ? `${title} (${t('defaultNumber')})` : title;
            return (
              <SelectItem key={row.id} value={row.id} className="rounded-lg py-2.5">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-medium">{label}</span>
                  {subtitle ? (
                    <span className="truncate text-xs text-muted-foreground">{subtitle}</span>
                  ) : null}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
