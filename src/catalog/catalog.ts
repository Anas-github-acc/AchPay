import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Product, ProductQuery } from './types.js';

const defaultCatalogPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  'catalog.json',
);

export class Catalog {
  private readonly bySku: Map<string, Product>;
  private readonly items: Product[];

  constructor(items: Product[]) {
    for (const item of items) validateProduct(item);
    const bySku = new Map<string, Product>();
    for (const item of items) {
      if (bySku.has(item.sku)) throw new Error(`Duplicate sku in catalog: ${item.sku}`);
      bySku.set(item.sku, Object.freeze({ ...item }));
    }
    this.bySku = bySku;
    this.items = [...bySku.values()];
  }

  static fromFile(path: string = defaultCatalogPath): Catalog {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`Catalog at ${path} must be a JSON array`);
    return new Catalog(parsed as Product[]);
  }

  get size(): number {
    return this.items.length;
  }

  all(): Product[] {
    return [...this.items];
  }

  get(sku: string): Product | undefined {
    return this.bySku.get(sku);
  }

  /** Throws a typed error rather than returning undefined — callers pricing a
   *  quote must never silently skip an unknown sku. */
  require(sku: string): Product {
    const product = this.bySku.get(sku);
    if (!product) throw new UnknownSkuError(sku);
    return product;
  }

  search(query: ProductQuery = {}): Product[] {
    const needle = query.q?.trim().toLowerCase();
    const results = this.items.filter((item) => {
      if (query.max_price_paise !== undefined && item.price_paise > query.max_price_paise) {
        return false;
      }
      if (query.category && item.category !== query.category) return false;
      if (!needle) return true;
      // Matching is over title/sku/category only. Descriptions are untrusted
      // free text; they are not part of the search surface.
      const haystack = `${item.title} ${item.sku} ${item.category}`.toLowerCase();
      return haystack.includes(needle);
    });
    results.sort((a, b) => a.price_paise - b.price_paise || a.sku.localeCompare(b.sku));
    return query.limit !== undefined ? results.slice(0, query.limit) : results;
  }
}

export class UnknownSkuError extends Error {
  readonly code = 'UNKNOWN_SKU';
  constructor(readonly sku: string) {
    super(`Unknown sku: ${sku}`);
    this.name = 'UnknownSkuError';
  }
}

function validateProduct(item: Product): void {
  if (typeof item?.sku !== 'string' || item.sku.length === 0) {
    throw new Error(`Catalog item missing sku: ${JSON.stringify(item)}`);
  }
  if (typeof item.title !== 'string' || item.title.length === 0) {
    throw new Error(`Catalog item ${item.sku} missing title`);
  }
  if (!Number.isSafeInteger(item.price_paise) || item.price_paise < 0) {
    throw new Error(`Catalog item ${item.sku} price_paise must be a non-negative integer paise`);
  }
  if (!Number.isSafeInteger(item.stock) || item.stock < 0) {
    throw new Error(`Catalog item ${item.sku} stock must be a non-negative integer`);
  }
  if (typeof item.category !== 'string' || item.category.length === 0) {
    throw new Error(`Catalog item ${item.sku} missing category`);
  }
}

let cached: Catalog | undefined;

/** Process-wide catalog, loaded once at first use (i.e. at boot). */
export function getCatalog(): Catalog {
  cached ??= Catalog.fromFile();
  return cached;
}

/** Test seam: swap the process catalog (used to simulate a price change). */
export function setCatalog(catalog: Catalog | undefined): void {
  cached = catalog;
}
