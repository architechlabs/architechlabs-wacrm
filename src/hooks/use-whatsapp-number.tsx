'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  readWhatsAppNumbers,
  type SavedWhatsAppConfig,
} from '@/lib/settings/read-whatsapp-config';

const STORAGE_KEY = 'wacrm:whatsapp-number';

interface WhatsAppNumberContextValue {
  numbers: SavedWhatsAppConfig[];
  selectedId: string | null;
  selected: SavedWhatsAppConfig | null;
  ready: boolean;
  selectNumber: (id: string) => void;
  reload: () => void;
}

const WhatsAppNumberContext = createContext<WhatsAppNumberContextValue | null>(null);

function storedId() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function urlId() {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('n');
}

export function WhatsAppNumberProvider({ children }: { children: React.ReactNode }) {
  const { accountId, profileLoading } = useAuth();
  const [numbers, setNumbers] = useState<SavedWhatsAppConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (profileLoading) return;
    if (!accountId) {
      setNumbers([]);
      setSelectedId(null);
      setReady(true);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const rows = await readWhatsAppNumbers(supabase, accountId, controller.signal);
        if (cancelled) return;
        setNumbers(rows);
        const preferred = urlId() || storedId();
        const match = rows.find((row) => row.id === preferred)
          ?? rows.find((row) => row.is_default)
          ?? rows[0]
          ?? null;
        setSelectedId(match?.id ?? null);
        if (match) {
          try { localStorage.setItem(STORAGE_KEY, match.id); } catch { /* ignore */ }
        }
      } catch {
        if (!cancelled) {
          setNumbers([]);
          setSelectedId(null);
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [accountId, profileLoading, reloadToken]);

  const selectNumber = useCallback((id: string) => {
    setSelectedId(id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
    const url = new URL(window.location.href);
    url.searchParams.set('n', id);
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }, []);

  const value = useMemo<WhatsAppNumberContextValue>(() => ({
    numbers,
    selectedId,
    selected: numbers.find((row) => row.id === selectedId) ?? null,
    ready,
    selectNumber,
    reload: () => setReloadToken((n) => n + 1),
  }), [numbers, selectedId, ready, selectNumber]);

  return (
    <WhatsAppNumberContext.Provider value={value}>
      {children}
    </WhatsAppNumberContext.Provider>
  );
}

export function useWhatsAppNumber() {
  const value = useContext(WhatsAppNumberContext);
  if (!value) {
    throw new Error('useWhatsAppNumber must be used inside WhatsAppNumberProvider');
  }
  return value;
}
