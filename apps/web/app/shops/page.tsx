'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, ApiError } from '../../lib/api';
import { readCached, writeCached } from '../../lib/cache';

type Shop = { id: string; name: string; slug: string; is_default: boolean };
type Product = { sku: string; originalSku?: string; title: string; description?: string; price_paise: number; stock: number; category: string; source?: 'verified' | 'unverified'; flagged?: boolean };
type ShopForm = { name: string; key_id: string; key_secret: string; webhook_secret: string };

const emptyShop: ShopForm = { name: '', key_id: '', key_secret: '', webhook_secret: '' };
const PAGE_SIZE = 20;
const PRODUCT_KEYS = ['sku', 'title', 'description', 'price_paise', 'stock', 'category', 'source', 'flagged'] as const;
const catalogCache = new Map<string, { items: Product[]; hasMore: boolean }>();

function priceInRupees(pricePaise: number): string { return (pricePaise / 100).toFixed(2); }

export default function ShopsPage() {
  const [shops, setShops] = useState<Shop[]>([]);
  const [selectedShop, setSelectedShop] = useState<Shop | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [shopForm, setShopForm] = useState<ShopForm>(emptyShop);
  const [showShopOverlay, setShowShopOverlay] = useState(false);
  const [jsonProduct, setJsonProduct] = useState<Product | null>(null);
  const [jsonDraft, setJsonDraft] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const debounceTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  async function loadShops(shopId?: string) {
    const cachedShops = readCached<Shop[]>('shops');
    if (cachedShops) {
      setShops(cachedShops);
      setSelectedShop(cachedShops.find((shop) => shop.id === shopId) ?? cachedShops[0] ?? null);
    }
    const data = await apiGet<{ shops: Shop[] }>('/shops');
    setShops(data.shops);
    writeCached('shops', data.shops);
    const selected = data.shops.find((shop) => shop.id === shopId) ?? data.shops[0] ?? null;
    setSelectedShop(selected);
    if (selected) await loadCatalog(selected.id, true); else setProducts([]);
  }

  async function loadCatalog(shopId: string, replace = false) {
    const offset = replace ? 0 : products.length;
    if (!replace && loadingMore) return;
    if (replace) {
      const cached = catalogCache.get(shopId) ?? readCached<{ items: Product[]; hasMore: boolean }>(`catalog:${shopId}`);
      if (cached) { setProducts(cached.items); setHasMore(cached.hasMore); catalogCache.set(shopId, cached); }
    }
    setLoadingMore(true);
    try {
      const data = await apiGet<{ items: Product[]; has_more: boolean }>(`/shops/${shopId}/products?limit=${PAGE_SIZE}&offset=${offset}`);
      const page = data.items.map((item) => ({ ...item, originalSku: item.sku }));
      setProducts((current) => {
        const next = replace ? page : [...current, ...page];
        catalogCache.set(shopId, { items: next, hasMore: data.has_more });
        writeCached(`catalog:${shopId}`, { items: next, hasMore: data.has_more });
        return next;
      });
      setHasMore(data.has_more);
    } finally { setLoadingMore(false); }
  }

  useEffect(() => {
    loadShops().catch((error) => {
      if (error instanceof ApiError && error.status === 401) { window.location.href = '/merchant/login?next=%2Fshops'; return; }
      setMessage('Could not load merchant shops.');
    });
  }, []);

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !selectedShop || !hasMore) return;
    const observer = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) void loadCatalog(selectedShop.id); }, { rootMargin: '360px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [selectedShop, hasMore, products.length, loadingMore]);

  useEffect(() => () => { debounceTimers.current.forEach((timer) => clearTimeout(timer)); }, []);

  function updateShopForm(key: keyof ShopForm, value: string) { setShopForm((current) => ({ ...current, [key]: value })); }

  async function createShop(event: FormEvent) {
    event.preventDefault(); setSaving('shop'); setMessage('');
    try {
      const data = await apiPost<{ shop: Shop }>('/merchant/account', { name: shopForm.name, key_id: shopForm.key_id || undefined, key_secret: shopForm.key_secret || undefined, webhook_secret: shopForm.webhook_secret || undefined });
      setShopForm(emptyShop); setShowShopOverlay(false); setMessage(`${data.shop.name} created.`); await loadShops(data.shop.id);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not create storefront.'); }
    finally { setSaving(null); }
  }

  function selectShop(shop: Shop) { setMessage(''); setSelectedShop(shop); setProducts([]); setHasMore(false); setJsonProduct(null); void loadCatalog(shop.id, true).catch(() => setMessage('Could not load this storefront catalog.')); }

  async function persistProduct(product: Product): Promise<Product | null> {
    if (!selectedShop || !product.sku.trim() || !product.title.trim() || !product.category.trim()) return null;
    setSaving(product.originalSku ?? product.sku);
    try {
      const saved = await apiPost<Product>(`/shops/${selectedShop.id}/products`, { previous_sku: product.originalSku, sku: product.sku.trim(), title: product.title.trim(), description: product.description?.trim() || undefined, price_paise: product.price_paise, stock: product.stock, category: product.category.trim(), source: product.source ?? 'verified' });
      const normalized = { ...saved, originalSku: saved.sku };
      setMessage(`${saved.title} saved.`);
      setProducts((current) => {
        const next = current.map((item) => item.originalSku === product.originalSku ? normalized : item);
        catalogCache.set(selectedShop.id, { items: next, hasMore });
        writeCached(`catalog:${selectedShop.id}`, { items: next, hasMore });
        return next;
      });
      return normalized;
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save product.'); return null; }
    finally { setSaving(null); }
  }

  function scheduleProductSave(product: Product) {
    const key = product.originalSku ?? product.sku;
    const existing = debounceTimers.current.get(key);
    if (existing) clearTimeout(existing);
    debounceTimers.current.set(key, setTimeout(() => { debounceTimers.current.delete(key); void persistProduct(product); }, 700));
  }

  function updateProduct(index: number, key: keyof Product, value: string) {
    const current = products[index];
    if (!current) return;
    const updated = { ...current, [key]: key === 'price_paise' ? Math.round(Number(value || 0) * 100) : key === 'stock' ? Number(value || 0) : value };
    setProducts((items) => items.map((item, itemIndex) => itemIndex === index ? updated : item));
    scheduleProductSave(updated);
  }

  function openJsonEditor(product: Product) {
    setJsonProduct(product);
    setJsonDraft(JSON.stringify({ sku: product.sku, title: product.title, description: product.description ?? '', price_paise: product.price_paise, stock: product.stock, category: product.category, source: product.source ?? 'verified', flagged: product.flagged ?? false }, null, 2));
  }

  function handleRowClick(product: Product) {
    if (window.matchMedia('(max-width: 760px)').matches) openJsonEditor(product);
  }

  async function saveJson(event: FormEvent) {
    event.preventDefault();
    if (!jsonProduct) return;
    try {
      const parsed: unknown = JSON.parse(jsonDraft);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON must be an object.');
      const record = parsed as Record<string, unknown>;
      const extra = Object.keys(record).filter((key) => !(PRODUCT_KEYS as readonly string[]).includes(key));
      if (extra.length) throw new Error(`Unsupported field: ${extra.join(', ')}`);
      if (typeof record.sku !== 'string' || typeof record.title !== 'string' || typeof record.category !== 'string') throw new Error('sku, title, and category must be strings.');
      if (!Number.isSafeInteger(record.price_paise) || !Number.isSafeInteger(record.stock) || Number(record.price_paise) < 0 || Number(record.stock) < 0) throw new Error('price_paise and stock must be non-negative integers.');
      if (record.description !== undefined && typeof record.description !== 'string') throw new Error('description must be a string.');
      if (record.source !== 'verified' && record.source !== 'unverified') throw new Error('source must be verified or unverified.');
      if (record.flagged !== (jsonProduct.flagged ?? false)) throw new Error('flagged is read-only.');
      const saved = await persistProduct({ sku: record.sku, title: record.title, description: record.description as string | undefined, price_paise: record.price_paise as number, stock: record.stock as number, category: record.category, source: record.source, flagged: record.flagged as boolean, originalSku: jsonProduct.originalSku });
      if (saved) { setJsonProduct(null); setJsonDraft(''); }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Invalid product JSON.'); }
  }

  async function deleteProduct(product: Product) {
    if (!selectedShop || !window.confirm(`Remove ${product.title || product.sku} from this catalog?`)) return;
    setSaving(product.originalSku ?? product.sku); setMessage('');
    try {
      const response = await fetch(`/api/shops/${encodeURIComponent(selectedShop.id)}/products/${encodeURIComponent(product.sku)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not remove product.');
      setProducts((current) => {
        const next = current.filter((item) => item !== product);
        catalogCache.set(selectedShop.id, { items: next, hasMore });
        writeCached(`catalog:${selectedShop.id}`, { items: next, hasMore });
        return next;
      }); setJsonProduct(null); setMessage(`${product.title || product.sku} removed.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not remove product.'); }
    finally { setSaving(null); }
  }

  async function addDefaultProduct() {
    if (!selectedShop || saving) return;
    const sku = `NEW-${Date.now().toString(36).toUpperCase()}`;
    const saved = await persistProduct({ sku, title: 'New item', description: '', price_paise: 0, stock: 0, category: 'general', source: 'verified' });
    if (saved) { setProducts((current) => { const next = [saved, ...current]; catalogCache.set(selectedShop.id, { items: next, hasMore }); writeCached(`catalog:${selectedShop.id}`, { items: next, hasMore }); return next; }); setJsonProduct(saved); setJsonDraft(JSON.stringify({ sku: saved.sku, title: saved.title, description: '', price_paise: 0, stock: 0, category: 'general', source: 'verified', flagged: false }, null, 2)); }
  }

  return <main className="page" id="main"><div className="wrap">
    <div className="page-heading"><div><p className="eyebrow">Merchant workspace</p><h1>Your storefronts.</h1><p>Each storefront has its own catalog and payment connection. Manage as many as your business needs.</p></div><button className="button button--secondary" type="button" onClick={() => setMessage('Connect to your shop is coming soon.')}>Connect to your shop <span className="chip dim">Coming soon</span></button></div>
    {message && <p className="notice" role="status">{message}</p>}
    <section className="panel storefront-panel" aria-labelledby="storefront-heading"><div className="panel-heading"><div><p className="eyebrow">Available storefronts</p><h2 id="storefront-heading">Choose a storefront</h2></div><span className="chip">{shops.length} storefronts</span></div><div className="storefront-grid">{shops.map((shop) => <button key={shop.id} className={`storefront-card${selectedShop?.id === shop.id ? ' storefront-card--selected' : ''}`} type="button" onClick={() => selectShop(shop)}><span className="storefront-card__name"><strong>{shop.name}</strong><small>{shop.is_default ? 'Shared test storefront' : 'Merchant storefront'}</small></span><span className="mono">{shop.slug}</span></button>)}<button className="storefront-add" type="button" onClick={() => setShowShopOverlay(true)}><span className="storefront-add__icon" aria-hidden="true">+</span><strong>Add storefront</strong><small>Create another shop for this merchant</small></button></div></section>
    <section className="panel catalog-panel" aria-labelledby="catalog-heading"><div className="panel-heading"><div><p className="eyebrow">Catalog management</p><h2 id="catalog-heading">{selectedShop ? selectedShop.name : 'Select a storefront'}</h2><p className="catalog-instruction"><span className="catalog-instruction--desktop">Double-click</span><span className="catalog-instruction--mobile">Tap</span> any row to edit its JSON.</p></div>{selectedShop && <button className="button button--compact catalog-add-button" type="button" onClick={() => void addDefaultProduct()} disabled={saving !== null}><span className="catalog-add-button__label">+ Add item</span><span className="catalog-add-button__icon" aria-hidden="true">+</span><span className="sr-only">Add item</span></button>}</div>
      {selectedShop ? <div className="catalog-table-scroll"><table className="catalog-table"><thead><tr><th>SKU</th><th>Title</th><th>Description</th><th>Price (paise)</th><th>Stock</th><th>Category</th><th>Source</th><th>Flagged</th></tr></thead><tbody>{products.map((product, index) => <tr key={product.originalSku ?? product.sku} onClick={() => handleRowClick(product)} onDoubleClick={() => openJsonEditor(product)} title="Double-click to edit JSON"><td><input aria-label="SKU" value={product.sku} onChange={(event) => updateProduct(index, 'sku', event.target.value)} /></td><td><input aria-label="Title" value={product.title} onChange={(event) => updateProduct(index, 'title', event.target.value)} /></td><td><input aria-label="Description" value={product.description ?? ''} onChange={(event) => updateProduct(index, 'description', event.target.value)} /></td><td><input aria-label="Price in paise" type="number" min="0" step="1" value={product.price_paise} onChange={(event) => updateProduct(index, 'price_paise', event.target.value)} /></td><td><input aria-label="Stock" type="number" min="0" step="1" value={product.stock} onChange={(event) => updateProduct(index, 'stock', event.target.value)} /></td><td><input aria-label="Category" value={product.category} onChange={(event) => updateProduct(index, 'category', event.target.value)} /></td><td><select aria-label="Source" value={product.source ?? 'verified'} onChange={(event) => updateProduct(index, 'source', event.target.value)}><option value="verified">verified</option><option value="unverified">unverified</option></select></td><td><input className="catalog-flagged" aria-label="Flagged" type="checkbox" checked={product.flagged ?? false} readOnly /></td></tr>)}</tbody></table><div ref={sentinel} className="catalog-sentinel" aria-live="polite">{loadingMore ? 'Loading more items…' : hasMore ? 'Scroll for more' : products.length ? 'All catalog items loaded' : 'No items yet'}</div></div> : <p className="form-help">Choose a storefront above to manage its products.</p>}
    </section>
  </div>
  {jsonProduct && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setJsonProduct(null); }}><section className="modal modal--json" role="dialog" aria-modal="true" aria-labelledby="json-editor-heading"><div className="panel-heading"><div><p className="eyebrow">Catalog row</p><h2 id="json-editor-heading">Edit product JSON</h2></div><button className="modal-close" type="button" onClick={() => setJsonProduct(null)} aria-label="Close JSON editor">×</button></div><p className="form-help">Only the product schema is accepted. Extra JSON fields are rejected.</p><form onSubmit={saveJson}><textarea className="json-editor" value={jsonDraft} onChange={(event) => setJsonDraft(event.target.value)} spellCheck={false} rows={18} aria-label="Product JSON" /><div className="modal-actions"><button className="button button--danger" type="button" onClick={() => void deleteProduct(jsonProduct)}>Delete item</button><span className="modal-actions__spacer" /><button className="button button--secondary" type="button" onClick={() => setJsonProduct(null)}>Cancel</button><button className="button" type="submit" disabled={saving !== null}>{saving ? 'Saving…' : 'Save JSON'}</button></div></form></section></div>}
  {showShopOverlay && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowShopOverlay(false); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-storefront-heading"><div className="panel-heading"><div><p className="eyebrow">New storefront</p><h2 id="new-storefront-heading">Add a storefront</h2></div><button className="modal-close" type="button" onClick={() => setShowShopOverlay(false)} aria-label="Close dialog">×</button></div><form className="merchant-form" onSubmit={createShop}><label htmlFor="shop-name">Storefront name</label><input id="shop-name" value={shopForm.name} onChange={(event) => updateShopForm('name', event.target.value)} placeholder="e.g. Anas Coffee" required /><label htmlFor="key-id">Razorpay key ID <span className="form-optional">optional</span></label><input id="key-id" value={shopForm.key_id} onChange={(event) => updateShopForm('key_id', event.target.value)} placeholder="rzp_test_…" /><label htmlFor="key-secret">Razorpay key secret <span className="form-optional">optional</span></label><input id="key-secret" type="password" value={shopForm.key_secret} onChange={(event) => updateShopForm('key_secret', event.target.value)} autoComplete="new-password" /><label htmlFor="webhook-secret">Webhook secret <span className="form-optional">optional</span></label><input id="webhook-secret" type="password" value={shopForm.webhook_secret} onChange={(event) => updateShopForm('webhook_secret', event.target.value)} autoComplete="new-password" /><p className="form-help">Credentials are encrypted at rest and never shown again.</p><div className="modal-actions"><button className="button button--secondary" type="button" onClick={() => setShowShopOverlay(false)}>Cancel</button><button className="button" type="submit" disabled={saving === 'shop'}>{saving === 'shop' ? 'Creating…' : 'Create storefront'}</button></div></form></section></div>}
  </main>;
}
