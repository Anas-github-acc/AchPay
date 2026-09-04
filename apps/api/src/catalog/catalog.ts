import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitiseCatalog } from './sanitise.js';
import type { IngestReport, Product, ProductQuery, RawProduct } from './types.js';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'data');
const defaultCatalogPath = join(dataDir, 'catalog.json');
const defaultReportPath = join(dataDir, 'ingest-report.json');

/** An empty report, for a Catalog built in memory rather than loaded from disk. */
function noReport(itemCount: number, flagged: number): IngestReport {
  return {
    generated_at: new Date(0).toISOString(),
    source: 'in-memory',
    items_seen: itemCount,
    items_loaded: itemCount,
    items_flagged: flagged,
    items_quarantined: 0,
    entries: [],
  };
}

export interface LoadCatalogOptions {
  /** Where to write the ingest report. `null` writes nothing (used by tests). */
  reportPath?: string | null;
  /** Suppress the boot summary line. */
  quiet?: boolean;
}

export class Catalog {
  private readonly bySku: Map<string, Product>;
  private readonly items: Product[];
  /** Median price per category, precomputed once. See categoryMedianPaise(). */
  private readonly medianByCategory: Map<string, number>;
  readonly report: IngestReport;

  /**
   * Takes items that have already been through the ingest sanitiser. Building a
   * Catalog directly (as tests and the re-pricing path do) does not re-sanitise:
   * sanitisation belongs to ingest, and running it here would make it a
   * read-path cost that is easy to forget on a new code path.
   */
  constructor(items: Array<RawProduct & { flagged?: boolean }>, report?: IngestReport) {
    for (const item of items) validateProduct(item as Product);
    const bySku = new Map<string, Product>();
    for (const item of items) {
      if (bySku.has(item.sku)) throw new Error(`Duplicate sku in catalog: ${item.sku}`);
      bySku.set(
        item.sku,
        Object.freeze({ ...item, source: item.source ?? 'verified', flagged: item.flagged ?? false }),
      );
    }
    this.bySku = bySku;
    this.items = [...bySku.values()];
    this.medianByCategory = computeCategoryMedians(this.items);
    this.report = report ?? noReport(this.items.length, this.items.filter((i) => i.flagged).length);
  }

  /**
   * The ingest path. Reads the file, sanitises and flags it, writes the report,
   * and prints the one line that tells an operator whether anything tried
   * something today.
   */
  static fromFile(path: string = defaultCatalogPath, opts: LoadCatalogOptions = {}): Catalog {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const { items, report } = sanitiseCatalog(parsed, { source: path });
    const catalog = new Catalog(items, report);

    const reportPath = opts.reportPath === undefined ? defaultReportPath : opts.reportPath;
    if (reportPath !== null) {
      writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    if (!opts.quiet) {
      console.log(
        `catalog: ${report.items_loaded} items loaded, ${report.items_flagged} flagged` +
          (report.items_quarantined > 0 ? `, ${report.items_quarantined} quarantined` : '') +
          (reportPath === null ? '' : ` (report: ${reportPath})`),
      );
    }
    return catalog;
  }

  get size(): number {
    return this.items.length;
  }

  get flaggedCount(): number {
    return this.items.filter((i) => i.flagged).length;
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

  /**
   * Median unit price across every item in `category`, integer paise.
   *
   * The policy engine must not compute this — it would need the whole catalog,
   * which would stop it being a pure function of its arguments. Instead the
   * quote service stamps the median onto each line at quote time, where it gets
   * covered by the quote signature and so cannot be tampered with in transit.
   *
   * An even-sized category takes the floor of the two middle prices, so the
   * result stays an integer number of paise. Returns 0 for a category with no
   * items, which the median rule reads as "unknown" and skips.
   */
  categoryMedianPaise(category: string): number {
    return this.medianByCategory.get(category) ?? 0;
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

function computeCategoryMedians(items: Product[]): Map<string, number> {
  const prices = new Map<string, number[]>();
  for (const item of items) {
    const list = prices.get(item.category);
    if (list) list.push(item.price_paise);
    else prices.set(item.category, [item.price_paise]);
  }
  const medians = new Map<string, number>();
  for (const [category, list] of prices) {
    list.sort((a, b) => a - b);
    const mid = list.length >> 1;
    medians.set(
      category,
      list.length % 2 === 1 ? list[mid]! : Math.floor((list[mid - 1]! + list[mid]!) / 2),
    );
  }
  return medians;
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
  // Tests neither write the report file nor print the boot line; both would be
  // noise in a suite that loads the catalog in every worker.
  const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  cached ??= Catalog.fromFile(defaultCatalogPath, {
    quiet: isTest,
    reportPath: isTest ? null : undefined,
  });
  return cached;
}

/** Test seam: swap the process catalog (used to simulate a price change). */
export function setCatalog(catalog: Catalog | undefined): void {
  cached = catalog;
}

export { defaultCatalogPath, defaultReportPath };
