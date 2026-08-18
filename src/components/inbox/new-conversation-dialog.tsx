'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Search, UserRoundPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { TemplatePicker, type TemplateSendValues } from './template-picker';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils';
import { isValidE164, sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import type { Contact, MessageTemplate } from '@/types';

type TargetMode = 'existing' | 'new';

interface TargetSelection {
  contactId?: string;
  name?: string;
  phone?: string;
}

interface NewConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConversationReady: (conversationId: string) => void | Promise<void>;
}

export function NewConversationDialog({
  open,
  onOpenChange,
  onConversationReady,
}: NewConversationDialogProps) {
  const t = useTranslations('Inbox.newConversation');
  const [mode, setMode] = useState<TargetMode>('existing');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(true);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedContactId, setSelectedContactId] = useState<string | null>(
    null
  );
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [targetError, setTargetError] = useState<string | null>(null);
  const [target, setTarget] = useState<TargetSelection | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const clientRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    void (async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('contacts')
        .select('id, user_id, account_id, phone, name, created_at, updated_at')
        .order('name', { ascending: true });
      if (cancelled) return;
      if (error) {
        setContacts([]);
        setContactsError(t('contactsLoadFailed'));
      } else {
        setContacts((data as Contact[]) ?? []);
      }
      setContactsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [open, t]);

  const filteredContacts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return contacts;
    return contacts.filter((contact) =>
      [contact.name, contact.phone].some((value) =>
        value?.toLowerCase().includes(query)
      )
    );
  }, [contacts, search]);

  const normalizedPhone = sanitizePhoneForMeta(phone);
  const validNewTarget = name.trim().length > 0 && isValidE164(normalizedPhone);
  const canContinue =
    mode === 'existing' ? selectedContactId !== null : validNewTarget;

  function reset() {
    setMode('existing');
    setSearch('');
    setSelectedContactId(null);
    setName('');
    setPhone('');
    setTargetError(null);
    setTarget(null);
    setContactsLoading(true);
    setContactsError(null);
    clientRequestIdRef.current = null;
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function continueToTemplate() {
    setTargetError(null);
    if (mode === 'existing') {
      if (!selectedContactId) {
        setTargetError(t('selectContactError'));
        return;
      }
      setTarget({ contactId: selectedContactId });
    } else {
      if (!name.trim()) {
        setTargetError(t('nameRequired'));
        return;
      }
      if (!isValidE164(normalizedPhone)) {
        setTargetError(t('invalidPhone'));
        return;
      }
      setTarget({ name: name.trim(), phone: `+${normalizedPhone}` });
    }

    clientRequestIdRef.current = crypto.randomUUID();
    onOpenChange(false);
    setTemplateOpen(true);
  }

  async function sendTemplate(
    template: MessageTemplate,
    values: TemplateSendValues
  ) {
    if (!target || !clientRequestIdRef.current) {
      throw new Error(t('targetMissing'));
    }

    let response: Response;
    try {
      response = await fetch('/api/whatsapp/conversations/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact_id: target.contactId,
          name: target.name,
          phone: target.phone,
          template_id: template.id,
          client_request_id: clientRequestIdRef.current,
          template_message_params: {
            body: values.body,
            headerText: values.headerText,
            buttonParams: values.buttonParams,
          },
        }),
      });
    } catch {
      // Keep the same request UUID. A retry after an ambiguous network failure
      // must resolve the original reservation instead of sending again.
      throw new Error(t('networkError'));
    }

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      conversation_id?: string;
    };
    if (!response.ok || !payload.conversation_id) {
      throw new Error(payload.error || t('sendFailed'));
    }

    await onConversationReady(payload.conversation_id);
    reset();
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="border-border bg-popover sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground flex items-center gap-2">
              <UserRoundPlus className="text-primary h-4 w-4" />
              {t('title')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('description')}
            </DialogDescription>
          </DialogHeader>

          <div className="border-border bg-background/50 grid grid-cols-2 rounded-md border p-1">
            {(['existing', 'new'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setTargetError(null);
                }}
                className={cn(
                  'rounded px-3 py-2 text-xs font-medium transition-colors',
                  mode === value
                    ? 'border-primary/30 bg-primary/10 text-primary border'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {value === 'existing' ? t('existingContact') : t('newContact')}
              </button>
            ))}
          </div>

          {mode === 'existing' ? (
            <div className="space-y-3">
              <div className="relative">
                <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('searchContacts')}
                  className="border-border bg-muted pl-9"
                />
              </div>
              <div className="border-border bg-background/40 max-h-64 overflow-y-auto rounded-md border">
                {contactsLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="text-primary h-5 w-5 animate-spin" />
                  </div>
                ) : contactsError ? (
                  <p className="p-4 text-center text-sm text-red-400">
                    {contactsError}
                  </p>
                ) : filteredContacts.length === 0 ? (
                  <p className="text-muted-foreground p-4 text-center text-sm">
                    {t('noContacts')}
                  </p>
                ) : (
                  filteredContacts.map((contact) => (
                    <button
                      key={contact.id}
                      type="button"
                      onClick={() => setSelectedContactId(contact.id)}
                      className={cn(
                        'border-border hover:bg-muted/60 flex w-full items-center gap-3 border-b px-3 py-2.5 text-left last:border-b-0',
                        selectedContactId === contact.id && 'bg-primary/10'
                      )}
                    >
                      <span className="bg-muted text-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
                        {(contact.name || contact.phone)
                          .charAt(0)
                          .toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground block truncate text-sm font-medium">
                          {contact.name || contact.phone}
                        </span>
                        <span className="text-muted-foreground block truncate text-xs">
                          {contact.phone}
                        </span>
                      </span>
                      {selectedContactId === contact.id && (
                        <Check className="text-primary h-4 w-4" />
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="new-contact-name">{t('customerName')}</Label>
                <Input
                  id="new-contact-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={200}
                  placeholder={t('namePlaceholder')}
                  className="border-border bg-muted"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-contact-phone">{t('whatsappNumber')}</Label>
                <Input
                  id="new-contact-phone"
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                  inputMode="tel"
                  maxLength={40}
                  placeholder="+91 98765 43210"
                  className="border-border bg-muted"
                />
                <p className="text-muted-foreground text-xs">
                  {t('phoneHint')}
                </p>
              </div>
            </div>
          )}

          {targetError && (
            <p role="alert" className="text-sm text-red-400">
              {targetError}
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button disabled={!canContinue} onClick={continueToTemplate}>
              {t('chooseTemplate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TemplatePicker
        open={templateOpen}
        onOpenChange={(next) => {
          setTemplateOpen(next);
          if (!next && clientRequestIdRef.current) reset();
        }}
        onSelect={sendTemplate}
      />
    </>
  );
}
