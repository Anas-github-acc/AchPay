import { NextResponse } from 'next/server';

export async function POST() {
  const response = NextResponse.json({ ok: true });
  for (const name of ['supabase_access_token', 'supabase_refresh_token', 'demo_access_token', 'demo_refresh_token']) {
    response.cookies.set(name, '', { path: '/', maxAge: 0, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' });
  }
  return response;
}
