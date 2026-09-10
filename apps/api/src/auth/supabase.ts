import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';

function requireSupabaseConfig(): { url: string; anonKey: string } {
  if (!config.supabase.url || !config.supabase.anonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for demo sessions');
  }
  return { url: config.supabase.url, anonKey: config.supabase.anonKey };
}

/** Client used for the shared permanent demo user and JWT verification. */
export function publicSupabase(): SupabaseClient {
  const { url, anonKey } = requireSupabaseConfig();
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface DemoSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user_id: string;
  role: 'merchant' | 'client';
}

export async function createDemoSession(role: 'merchant' | 'client' = 'client'): Promise<DemoSession> {
  const email = role === 'merchant' ? config.supabase.demoMerchantEmail : config.supabase.demoClientEmail;
  const password = role === 'merchant' ? config.supabase.demoMerchantPassword : config.supabase.demoClientPassword;
  if (!email || !password) {
    throw new Error(`Demo ${role} credentials are not configured`);
  }
  const { data, error } = await publicSupabase().auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session || !data.user) {
    throw new Error(error?.message ?? 'Supabase did not return an anonymous session');
  }
  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_in: data.session.expires_in ?? 3600,
    user_id: data.user.id,
    role,
  };
}

export async function verifyDemoToken(token: string): Promise<string | undefined> {
  const userId = await verifySupabaseToken(token);
  if (config.supabase.demoUserId && userId !== config.supabase.demoUserId) return undefined;
  return userId;
}

export async function verifySupabaseToken(token: string): Promise<string | undefined> {
  const { data, error } = await publicSupabase().auth.getUser(token);
  if (error || !data.user) return undefined;
  return data.user.id;
}
