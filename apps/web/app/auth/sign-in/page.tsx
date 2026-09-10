import Link from 'next/link';
import { BrandMark } from '../../brand-mark';
import { AuthPanel } from '../auth-panel';

export const dynamic = 'force-dynamic';

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const nextPath = params.next?.startsWith('/') && !params.next.startsWith('//') ? params.next : undefined;
  return (
    <main className="auth-page" id="main">
      <section className="auth-card" aria-labelledby="auth-title">
        <Link href="/" className="auth-logo" aria-label="AchPay home"><BrandMark className="auth-logo-mark" /><span>AchPay</span></Link>
        <p className="eyebrow">Secure access</p>
        <h1 id="auth-title">Sign in to AchPay.</h1>
        <p className="auth-copy">Use Google to sign in or create your account. Your mandates and audit history stay tied to your identity.</p>
        <AuthPanel nextPath={nextPath} />
        <p className="auth-footnote">Need a merchant workspace? <Link href="/merchant/login">Register as a merchant</Link></p>
      </section>
    </main>
  );
}
