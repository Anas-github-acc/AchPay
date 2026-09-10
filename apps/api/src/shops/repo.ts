import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/pool.js';
import { Catalog } from '../catalog/catalog.js';
import { sanitiseCatalog } from '../catalog/sanitise.js';
import type { Product, RawProduct } from '../catalog/types.js';
import { encryptSecret } from './crypto.js';

export interface Shop { id: string; name: string; slug: string; is_default: boolean; owner_id?: string; }
export interface CreateShopInput { name: string; owner_id?: string; key_id?: string; key_secret?: string; webhook_secret?: string; }

const catalogPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'data', 'catalog.json');

export async function ensureDefaultShop(): Promise<void> {
  const existing = await pool.query<{ id: string }>(`select id from shops where is_default = true limit 1`);
  if (existing.rows[0]) return;
  const parsed = JSON.parse(await readFile(catalogPath, 'utf8')) as unknown;
  const { items } = sanitiseCatalog(parsed, { source: catalogPath });
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`insert into shops (id, name, slug, is_default) values ('shop_achcoffeezone', 'AchCaffeeZone', 'achcaffeezone', true) on conflict do nothing`);
    for (const item of items) await insertProduct(client, 'shop_achcoffeezone', item);
    await client.query('commit');
  } catch (err) { await client.query('rollback'); throw err; } finally { client.release(); }
}

async function insertProduct(client: { query: Function }, shopId: string, item: RawProduct & { flagged?: boolean }): Promise<void> {
  await client.query(`insert into shop_products (shop_id, sku, title, description, price_paise, stock, category, source, flagged)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (shop_id, sku) do nothing`,
    [shopId, item.sku, item.title, item.description ?? null, item.price_paise, item.stock, item.category, item.source ?? 'verified', item.flagged ?? false]);
}

export async function listShops(ownerId?: string): Promise<Shop[]> {
  const { rows } = await pool.query<Shop>(`select id,name,slug,is_default,owner_id from shops where is_default or owner_id = $1 order by is_default desc, created_at desc`, [ownerId ?? null]);
  return rows;
}

export async function getShop(id: string, ownerId?: string): Promise<Shop | undefined> {
  const { rows } = await pool.query<Shop>(`select id,name,slug,is_default,owner_id from shops where id=$1 and (is_default or owner_id=$2)`, [id, ownerId ?? null]);
  return rows[0];
}

export async function createShop(input: CreateShopInput): Promise<Shop> {
  const id = `shop_${randomUUID().replaceAll('-', '')}`;
  const slug = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${id.slice(-6)}`;
  const { rows } = await pool.query<Shop>(`insert into shops (id,name,slug,owner_id,razorpay_key_id,razorpay_key_secret_encrypted,razorpay_webhook_secret_encrypted)
    values ($1,$2,$3,$4,$5,$6,$7) returning id,name,slug,is_default,owner_id`, [id, input.name.trim(), slug, input.owner_id ?? null, input.key_id ?? null, input.key_secret ? encryptSecret(input.key_secret) : null, input.webhook_secret ? encryptSecret(input.webhook_secret) : null]);
  return rows[0]!;
}

export async function listProducts(shopId: string): Promise<Catalog> {
  const { rows } = await pool.query<Product>(`select sku,title,description,price_paise,stock,category,source,flagged from shop_products where shop_id=$1 order by sku`, [shopId]);
  return new Catalog(rows);
}

export async function upsertProduct(shopId: string, product: RawProduct): Promise<void> {
  await pool.query(`insert into shop_products (shop_id,sku,title,description,price_paise,stock,category,source,flagged) values ($1,$2,$3,$4,$5,$6,$7,$8,false)
    on conflict (shop_id,sku) do update set title=excluded.title,description=excluded.description,price_paise=excluded.price_paise,stock=excluded.stock,category=excluded.category,source=excluded.source,updated_at=now()`, [shopId, product.sku, product.title, product.description ?? null, product.price_paise, product.stock, product.category, product.source ?? 'verified']);
}

export async function deleteProduct(shopId: string, sku: string): Promise<void> { await pool.query('delete from shop_products where shop_id=$1 and sku=$2', [shopId, sku]); }
