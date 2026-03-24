// PreMeet – Supabase Client
// Initializes the Supabase client for use in the Chrome extension background script.
// Uses environment variables injected at build time via Vite.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    '[PreMeet] Supabase credentials not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env'
  );
}

export const supabase: SupabaseClient<Database> = createClient<Database>(
  SUPABASE_URL ?? '',
  SUPABASE_ANON_KEY ?? '',
  {
    auth: {
      // Chrome extensions use chrome.storage for token persistence
      storage: {
        getItem: async (key: string) => {
          const result = await chrome.storage.local.get(key);
          return result[key] ?? null;
        },
        setItem: async (key: string, value: string) => {
          await chrome.storage.local.set({ [key]: value });
        },
        removeItem: async (key: string) => {
          await chrome.storage.local.remove(key);
        },
      },
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
    db: {
      schema: 'public',
    },
    global: {
      headers: {
        'x-client-info': 'premeet-extension',
      },
    },
  }
);
