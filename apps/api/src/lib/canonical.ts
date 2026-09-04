/**
 * Canonical JSON: object keys sorted lexicographically at every depth, arrays
 * left in order, no insignificant whitespace. Two structurally equal values
 * always produce the same string, which is what makes an HMAC over it stable.
 *
 * `undefined` properties are dropped (as JSON.stringify would); `undefined`
 * inside an array becomes `null` (likewise). Numbers must be integers or
 * safe-integer-free of float drift — money is paise, so this holds by rule.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    if (src[key] === undefined) continue;
    out[key] = canonicalise(src[key]);
  }
  return out;
}
