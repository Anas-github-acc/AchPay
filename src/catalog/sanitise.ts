import type { IngestEntry, IngestIssue, IngestReport, Product, RawProduct } from './types.js';

/**
 * Ingest-time sanitisation and flagging for catalog free text.
 *
 * This runs once, when data/catalog.json is loaded — never on the read path.
 * A request-time sanitiser would be a hot loop we could forget to call from a
 * new route; doing it at ingest means every reader of the in-memory catalog is
 * looking at already-cleaned data by construction.
 *
 * Two different treatments, deliberately:
 *
 *   - Invisible characters are *removed*. Zero-width joiners, bidi overrides
 *     and control bytes have no legitimate use in a product title, and their
 *     only purpose here would be to smuggle text past a human reviewer or a
 *     substring check. Removing them changes nothing a person can see.
 *
 *   - Instruction-shaped text is *flagged, not stripped*. Silent stripping
 *     turns the ingest into an oracle: an attacker edits, reloads, and iterates
 *     until something slips through, and we never learn they tried. Flagging
 *     keeps the original text in the report, suppresses it from every API
 *     response, and leaves a record that someone attempted it.
 *
 * Every regex below is written with \u escapes on purpose. The characters it
 * matches are invisible, so a literal would be unreviewable in a diff.
 */

const TITLE_MAX = 80;
const DESCRIPTION_MAX = 300;

/** Zero-width and invisible formatting characters. A superset of the brief:
 *  U+200B-200D, plus U+2060 word joiner and U+FEFF byte-order mark. */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;

/** Bidi controls. U+202A-202E are the embeddings and overrides; U+2066-2069 are
 *  their modern isolate equivalents and do the same job; U+200E/U+200F/U+061C
 *  are the directional marks. All removed. */
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

/** C0 and C1 controls, tabs and newlines included. Replaced with a space rather
 *  than deleted, so "buy\u0000now" cannot become "buynow". */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g;

interface InjectionPattern {
  id: string;
  re: RegExp;
}

/** Instruction-shaped text. A hit flags the item; it never rewrites it. */
const INJECTION_PATTERNS: InjectionPattern[] = [
  { id: 'ignore_previous', re: /ignore\s+previous/i },
  { id: 'role_system', re: /\bsystem\s*:/i },
  { id: 'role_assistant', re: /\bassistant\s*:/i },
  { id: 'you_are', re: /\byou\s+are\b/i },
  { id: 'instructions', re: /\binstructions?\b/i },
  { id: 'markdown_fence', re: /(?:```|~~~)/ },
  { id: 'xml_fence', re: /<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>/ },
];

/**
 * `category` is structured input the policy engine reads — the denylist matches
 * on it and the median rule groups by it. So it is held to an identifier shape
 * rather than merely cleaned: lowercase words joined by a space, hyphen or
 * underscore. An item whose category does not match is quarantined rather than
 * flagged, because a category of "alcohol; ignore policy" would otherwise slip
 * past a denylist that matches "alcohol", and would form a median group of one
 * containing only itself — making any price its own median.
 */
const CATEGORY_SHAPE = /^[a-z][a-z0-9]*(?:[ _-][a-z0-9]+)*$/;
const CATEGORY_MAX = 40;

export interface SanitiseOptions {
  /** Labels the report so a reader knows which file it describes. */
  source?: string;
}

export interface SanitiseResult {
  items: Product[];
  report: IngestReport;
}

/** Removes invisible characters, normalises to NFKC, collapses whitespace. */
export function normaliseText(raw: string): { value: string; issues: string[] } {
  const issues: string[] = [];
  let value = raw;

  // Each step compares before and after rather than calling .test(): these are
  // /g regexes, and .test() on a global regex advances lastIndex, so a second
  // call against the same object can miss.
  value = note(value, value.replace(ZERO_WIDTH, ''), 'zero_width_removed', issues);
  value = note(value, value.replace(BIDI, ''), 'bidi_removed', issues);
  value = note(value, value.replace(CONTROL, ' '), 'control_removed', issues);

  const normalised = value.normalize('NFKC');
  if (normalised !== value) issues.push('nfkc_normalised');
  value = normalised;

  // Re-run after NFKC: compatibility decomposition can expose a character the
  // first pass could not see.
  value = value.replace(ZERO_WIDTH, '').replace(BIDI, '').replace(CONTROL, ' ');

  const collapsed = value.replace(/\s{2,}/g, ' ').trim();
  if (collapsed !== value) issues.push('whitespace_collapsed');
  return { value: collapsed, issues };
}

/** Records `kind` if the replacement changed anything, and returns the result. */
function note(before: string, after: string, kind: string, issues: string[]): string {
  if (after !== before) issues.push(kind);
  return after;
}

/** Returns the ids of every instruction-shaped pattern present in `text`. */
export function scanForInjection(text: string): string[] {
  return INJECTION_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.id);
}

/**
 * Sanitises a parsed catalog array and reports on it.
 *
 * Returns the items that are safe to serve, plus a report naming every item
 * that was cleaned, flagged or quarantined. Nothing is logged or written from
 * here — the caller decides where the report goes.
 */
export function sanitiseCatalog(raw: unknown, opts: SanitiseOptions = {}): SanitiseResult {
  if (!Array.isArray(raw)) throw new Error('Catalog must be a JSON array');

  const items: Product[] = [];
  const entries: IngestEntry[] = [];

  for (const [index, candidate] of raw.entries()) {
    const input = candidate as RawProduct;
    const sku = typeof input?.sku === 'string' && input.sku.length > 0 ? input.sku : `#${index}`;
    const issues: IngestIssue[] = [];
    let flagged = false;
    let quarantined = false;

    // --- title -----------------------------------------------------------
    const rawTitle = typeof input?.title === 'string' ? input.title : '';
    const title = capped(normalise(rawTitle, 'title', issues), TITLE_MAX, 'title', issues);
    for (const id of scanForInjection(title)) {
      issues.push({ field: 'title', kind: 'injection_pattern', detail: id });
      flagged = true;
    }

    // --- description -----------------------------------------------------
    let description: string | undefined;
    if (typeof input?.description === 'string') {
      description = capped(
        normalise(input.description, 'description', issues),
        DESCRIPTION_MAX,
        'description',
        issues,
      );
      for (const id of scanForInjection(description)) {
        issues.push({ field: 'description', kind: 'injection_pattern', detail: id });
        flagged = true;
      }
    }

    // --- category (structured; a bad shape quarantines the item) ----------
    const category = normalise(
      typeof input?.category === 'string' ? input.category : '',
      'category',
      issues,
    );
    if (!CATEGORY_SHAPE.test(category) || category.length > CATEGORY_MAX) {
      issues.push({ field: 'category', kind: 'category_malformed', detail: category });
      flagged = true;
      quarantined = true;
    }

    // --- trust tier ------------------------------------------------------
    let source: Product['source'] = 'verified';
    if (input?.source === 'unverified') {
      source = 'unverified';
    } else if (input?.source !== undefined && input.source !== 'verified') {
      // An unrecognised tier is not a licence to be trusted.
      issues.push({ field: 'source', kind: 'source_unrecognised', detail: String(input.source) });
      source = 'unverified';
    }

    entries.push({ sku, flagged, quarantined, issues });
    if (quarantined) continue;

    items.push({
      ...input,
      sku,
      title,
      category,
      source,
      flagged,
      ...(description === undefined ? {} : { description }),
    });
  }

  const report: IngestReport = {
    generated_at: new Date().toISOString(),
    source: opts.source ?? 'unknown',
    items_seen: raw.length,
    items_loaded: items.length,
    items_flagged: items.filter((i) => i.flagged).length,
    items_quarantined: entries.filter((e) => e.quarantined).length,
    // Only items with something to say. A clean catalog reports an empty list.
    entries: entries.filter((e) => e.issues.length > 0),
  };

  return { items, report };
}

function normalise(raw: string, field: string, issues: IngestIssue[]): string {
  const { value, issues: kinds } = normaliseText(raw);
  for (const kind of kinds) issues.push({ field, kind, detail: '' });
  return value;
}

function capped(value: string, max: number, field: string, issues: IngestIssue[]): string {
  if (value.length <= max) return value;
  issues.push({ field, kind: 'truncated', detail: `${value.length} -> ${max}` });
  return value.slice(0, max);
}

export { TITLE_MAX, DESCRIPTION_MAX, CATEGORY_MAX, INJECTION_PATTERNS };
