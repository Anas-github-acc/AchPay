import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { verifyDemoToken, verifySupabaseToken } from './supabase.js';

declare module 'fastify' {
  interface FastifyRequest {
    demoUserId?: string;
    authRole?: 'merchant' | 'client';
    authProvider?: 'google' | 'demo';
    isDemo?: boolean;
  }
}

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers.cookie;
  if (!raw) return undefined;
  for (const item of raw.split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

export async function resolveDemoUser(request: FastifyRequest): Promise<string | undefined> {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : cookieValue(request, 'demo_access_token');
  if (!token) return undefined;
  const userId = await verifyDemoToken(token);
  request.demoUserId = userId;
  return userId;
}

/** Resolves any authenticated Supabase user, including Google OAuth users. */
export async function resolveUser(request: FastifyRequest): Promise<string | undefined> {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : cookieValue(request, 'supabase_access_token') ?? cookieValue(request, 'demo_access_token');
  if (!token) return undefined;
  const userId = await verifySupabaseToken(token);
  request.demoUserId = userId;
  const merchantDemo = userId !== undefined && userId === config.supabase.demoMerchantUserId;
  const clientDemo = userId !== undefined && userId === config.supabase.demoClientUserId;
  request.isDemo = merchantDemo || clientDemo;
  request.authProvider = request.isDemo ? 'demo' : 'google';
  if (merchantDemo || clientDemo) {
    request.authRole = merchantDemo ? 'merchant' : 'client';
  } else {
    const role = await pool.query<{ role: 'merchant' | 'client'; is_demo: boolean; auth_provider: 'google' | 'demo' }>('select role, is_demo, auth_provider from user_roles where user_id = $1', [userId]);
    request.authRole = role.rows[0]?.role;
    request.isDemo = role.rows[0]?.is_demo ?? false;
    request.authProvider = role.rows[0]?.auth_provider ?? 'google';
  }
  return userId;
}

export function requireRole(request: FastifyRequest, reply: FastifyReply, role: 'merchant' | 'client'): boolean {
  if (request.authRole !== role) {
    void reply.code(403).send({ error: 'ROLE_FORBIDDEN', required_role: role });
    return false;
  }
  return true;
}

export async function requireDemoUser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | undefined> {
  const userId = await resolveDemoUser(request);
  if (!userId && config.demoAuthRequired) {
    await reply.code(401).send({ error: 'DEMO_SESSION_REQUIRED' });
    return undefined;
  }
  return userId;
}

export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<string | undefined> {
  const userId = await resolveUser(request);
  if (!userId) {
    await reply.code(401).send({ error: 'AUTHENTICATION_REQUIRED' });
    return undefined;
  }
  return userId;
}

export function clearDemoCookies(reply: FastifyReply): void {
  const options = 'Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax';
  reply.header('set-cookie', [`demo_access_token=; ${options}`, `demo_refresh_token=; ${options}`]);
}

export function setDemoCookies(reply: FastifyReply, accessToken: string, refreshToken: string): void {
  const base = 'Path=/; HttpOnly; Secure; SameSite=Lax';
  reply.header('set-cookie', [
    `demo_access_token=${encodeURIComponent(accessToken)}; Max-Age=3600; ${base}`,
    `demo_refresh_token=${encodeURIComponent(refreshToken)}; Max-Age=2592000; ${base}`,
  ]);
}
