import { createClient } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const next = request.nextUrl.searchParams.get('next') ?? '/ledger';
  const role = request.nextUrl.searchParams.get('role');
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/ledger';
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!code || !baseUrl || !anonKey) {
    return NextResponse.redirect(new URL('/auth/sign-in?error=oauth_configuration', request.url));
  }

  const supabase = createClient(baseUrl, anonKey, { auth: { persistSession: false } });
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.session) {
    return NextResponse.redirect(new URL('/auth/sign-in?error=oauth_failed', request.url));
  }

  if (role === 'merchant' || role === 'client') {
    const apiBase = process.env.API_BASE_URL;
    if (!apiBase) return NextResponse.redirect(new URL('/auth/sign-in?error=api_configuration', request.url));
    const roleResponse = await fetch(`${apiBase}/auth/role`, {
      method: 'POST',
      headers: { authorization: `Bearer ${data.session.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role }),
      cache: 'no-store',
    });
    if (!roleResponse.ok) return NextResponse.redirect(new URL('/auth/sign-in?error=role_setup', request.url));
  }

  const response = NextResponse.redirect(new URL(safeNext, request.url));
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.headers.append('set-cookie', `supabase_access_token=${encodeURIComponent(data.session.access_token)}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax${secure}`);
  response.headers.append('set-cookie', `supabase_refresh_token=${encodeURIComponent(data.session.refresh_token)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secure}`);
  return response;
}
