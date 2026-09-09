import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.env.SUPABASE_DEMO_EMAIL ?? 'demo@achpay.local';
const password = process.env.SUPABASE_DEMO_PASSWORD;

if (!url || !serviceRoleKey || !password) {
  throw new Error(
    'Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_DEMO_PASSWORD before provisioning',
  );
}

const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: users, error: listError } = await admin.auth.admin.listUsers({
  page: 1,
  perPage: 1000,
});
if (listError) throw listError;

const existing = users.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
const result = existing
  ? await admin.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
      user_metadata: { demo: true },
    })
  : await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { demo: true },
    });

if (result.error || !result.data.user) throw result.error ?? new Error('Demo user was not returned');
console.log(`SUPABASE_DEMO_USER_ID=${result.data.user.id}`);
console.log(`SUPABASE_DEMO_EMAIL=${email}`);
