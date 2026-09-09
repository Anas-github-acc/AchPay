import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { verifyDemoToken } from './supabase.js';

declare module 'fastify' {
  interface FastifyRequest {
    demoUserId?: string;
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
