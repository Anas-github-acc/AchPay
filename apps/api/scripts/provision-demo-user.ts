import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

type DemoUser = { role: 'merchant' | 'client'; email: string; password: string };

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const users: DemoUser[] = [
  { role: 'client', email: process.env.SUPABASE_DEMO_EMAIL ?? 'demo@achpay.local', password: process.env.SUPABASE_DEMO_PASSWORD ?? '' },
  { role: 'merchant', email: 'merchant_demo@achpay.com', password: 'merchant123' },
];

if (!url || !serviceRoleKey || users.some((user) => !user.password)) {
  throw new Error(
    'Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_DEMO_PASSWORD before provisioning',
  );
}

const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: listed, error: listError } = await admin.auth.admin.listUsers({
  page: 1,
  perPage: 1000,
});
if (listError) throw listError;

for (const demo of users) {
  const existing = listed.users.find((user) => user.email?.toLowerCase() === demo.email.toLowerCase());
  const result = existing
    ? await admin.auth.admin.updateUserById(existing.id, { password: demo.password, email_confirm: true, user_metadata: { demo: true, role: demo.role } })
    : await admin.auth.admin.createUser({ email: demo.email, password: demo.password, email_confirm: true, user_metadata: { demo: true, role: demo.role } });
  if (result.error || !result.data.user) throw result.error ?? new Error(`${demo.role} demo user was not returned`);
  const { error: roleError } = await admin.from('user_roles').upsert({ user_id: result.data.user.id, role: demo.role, is_demo: true, auth_provider: 'demo' });
  if (roleError) throw roleError;
  if (demo.role === 'merchant') {
    const { data: account } = await admin.from('merchant_accounts').select('username').eq('user_id', result.data.user.id).maybeSingle();
    const username = account?.username && account.username !== 'merchant_demo' ? account.username : `merchant_demo_${randomUUID().slice(0, 8)}`;
    const { error: accountError } = await admin.from('merchant_accounts').upsert({ user_id: result.data.user.id, username, email: demo.email, is_demo: true });
    if (accountError) throw accountError;
    const { error: shopError } = await admin.from('shops').update({ owner_id: result.data.user.id }).eq('id', 'shop_achcoffeezone');
    if (shopError) throw shopError;
    console.log(`SUPABASE_DEMO_MERCHANT_USERNAME=${username}`);
  }
  console.log(`SUPABASE_DEMO_${demo.role.toUpperCase()}_USER_ID=${result.data.user.id}`);
  console.log(`SUPABASE_DEMO_${demo.role.toUpperCase()}_EMAIL=${demo.email}`);
}
