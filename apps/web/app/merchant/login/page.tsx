import Link from 'next/link';
import { BrandMark } from '../../brand-mark';
import { AuthPanel } from '../../auth/auth-panel';

export const dynamic = 'force-dynamic';

export default function MerchantLoginPage() {
  return (
    <main className="auth-page" id="main">
      <section className="auth-card merchant-auth-card" aria-labelledby="merchant-auth-title">
        <Link href="/" className="auth-logo" aria-label="AchPay home"><BrandMark className="auth-logo-mark" /><span>AchPay</span></Link>
        <p className="eyebrow">Merchant workspace</p>
        <h1 id="merchant-auth-title">Put your storefront to work.</h1>
        <p className="auth-copy">Sign in to manage your shop, catalog, payment connection, and merchant-owned records.</p>
        <div className="auth-choice"><span className="auth-choice-number">01</span><div><strong>Sign in to demo account</strong><small>Explore the merchant workspace with a safe shared account.</small></div></div>
        <AuthPanel merchant />
        <div className="auth-choice auth-choice--secondary"><span className="auth-choice-number">02</span><div><strong>Register merchant account</strong><small>Use Google to create your own merchant identity and shop.</small></div></div>
        <p className="auth-footnote">Already have a merchant account? <Link href="/auth/sign-in?next=%2Fshops">Sign in here</Link></p>
      </section>
    </main>
  );
}
