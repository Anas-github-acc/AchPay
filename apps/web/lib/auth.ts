import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export async function requireWebAuth(nextPath: string): Promise<void> {
  const store = await cookies();
  const authenticated = store.has('supabase_access_token') || store.has('demo_access_token');
  if (!authenticated) redirect(`/auth/sign-in?next=${encodeURIComponent(nextPath)}`);
}
