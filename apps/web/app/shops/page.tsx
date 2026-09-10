'use client';

import { FormEvent, useEffect, useState } from 'react';
import { apiGet, apiPost } from '../../lib/api';

type Shop = { id: string; name: string; slug: string; is_default: boolean };
type Product = { sku: string; title: string; price_paise: number; stock: number; category: string };

export default function ShopsPage() {
  const [shops, setShops] = useState<Shop[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [name, setName] = useState('');
  const [keyId, setKeyId] = useState('');
  const [keySecret, setKeySecret] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(shopId = 'shop_achcoffeezone') {
    const data = await apiGet<{ shops: Shop[] }>('/shops');
    setShops(data.shops);
    const selected = data.shops.find((shop) => shop.id === shopId) ?? data.shops[0];
    if (selected) setProducts((await apiGet<{ items: Product[] }>(`/shops/${selected.id}/products`)).items);
  }

  useEffect(() => { load().catch(() => setMessage('Start a demo session to manage merchant shops.')); }, []);

  async function createMerchant(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try { const data = await apiPost<{ shop: Shop }>('/merchant/account', { name, key_id: keyId || undefined, key_secret: keySecret || undefined, webhook_secret: webhookSecret || undefined }); setName(''); setKeyId(''); setKeySecret(''); setWebhookSecret(''); setMessage(`${data.shop.name} created.`); await load(data.shop.id); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not create shop.'); }
    finally { setBusy(false); }
  }

  return (
    <main className="page" id="main">
      <div className="wrap">
        <div className="page-heading">
          <div><p className="eyebrow">Merchant workspace</p><h1>Your shops.</h1><p>Each shop owns its catalog and payment connection. AchCaffeeZone is shared for safe testing.</p></div>
          <button className="button button--secondary" type="button" onClick={() => setMessage('Connect to your shop is coming soon.')}>Connect to your shop <span className="chip dim">Coming soon</span></button>
        </div>
        {message && <p className="notice" role="status">{message}</p>}
        <section className="shop-layout">
          <div className="panel"><div className="panel-heading"><div><p className="eyebrow">Available shops</p><h2>Choose a storefront</h2></div><span className="chip">{shops.length} shops</span></div>
            <div className="shop-list">{shops.map((shop) => <button key={shop.id} className="shop-row" type="button" onClick={() => load(shop.id)}><span><strong>{shop.name}</strong><small>{shop.is_default ? 'Shared test shop' : 'Your merchant shop'}</small></span><span className="mono">{shop.slug}</span></button>)}</div>
          </div>
          <div className="panel"><div className="panel-heading"><div><p className="eyebrow">Create merchant account</p><h2>Open a new shop</h2></div></div>
            <form className="merchant-form" onSubmit={createMerchant}><label htmlFor="shop-name">Shop name</label><input id="shop-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Anas Coffee" required /><label htmlFor="key-id">Razorpay key ID <span className="form-optional">optional</span></label><input id="key-id" value={keyId} onChange={(event) => setKeyId(event.target.value)} placeholder="rzp_test_…" /><label htmlFor="key-secret">Razorpay key secret <span className="form-optional">optional</span></label><input id="key-secret" type="password" value={keySecret} onChange={(event) => setKeySecret(event.target.value)} autoComplete="new-password" /><label htmlFor="webhook-secret">Webhook secret <span className="form-optional">optional</span></label><input id="webhook-secret" type="password" value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} autoComplete="new-password" /><p className="form-help">Credentials are encrypted at rest and never shown again. Shop connection is stored now; provider switching is coming soon.</p><button className="button" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create merchant account'}</button></form>
          </div>
        </section>
        <section className="panel catalog-panel"><div className="panel-heading"><div><p className="eyebrow">Catalog preview</p><h2>{products.length ? 'Products in selected shop' : 'Select a shop to see its catalog'}</h2></div></div><div className="product-grid">{products.slice(0, 12).map((product) => <article className="product-card" key={product.sku}><span className="chip dim">{product.category}</span><h3>{product.title}</h3><p className="mono">₹{(product.price_paise / 100).toFixed(2)} · {product.stock} in stock</p></article>)}</div></section>
      </div>
    </main>
  );
}
