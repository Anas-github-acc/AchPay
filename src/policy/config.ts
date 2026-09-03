import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { PolicyConfig } from './types.js';

const defaultPolicyPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'policy.yaml',
);

export function loadPolicy(path: string = defaultPolicyPath): PolicyConfig {
  const parsed = parse(readFileSync(path, 'utf8')) as Partial<PolicyConfig>;
  const policy: PolicyConfig = {
    per_txn_max_paise: requirePaise(parsed, 'per_txn_max_paise'),
    daily_max_paise: requirePaise(parsed, 'daily_max_paise'),
    gate_above_paise: requirePaise(parsed, 'gate_above_paise'),
    velocity_max_per_hour: requireCount(parsed, 'velocity_max_per_hour'),
    category_denylist: requireStringList(parsed, 'category_denylist'),
    require_mandate_headroom: parsed.require_mandate_headroom !== false,
    max_qty_per_sku: requirePositiveCount(parsed, 'max_qty_per_sku'),
    max_line_items: requirePositiveCount(parsed, 'max_line_items'),
    gate_if_price_above_category_median_multiple: requireMultiple(
      parsed,
      'gate_if_price_above_category_median_multiple',
    ),
  };
  if (policy.gate_above_paise > policy.per_txn_max_paise) {
    throw new Error(
      'policy.yaml: gate_above_paise exceeds per_txn_max_paise, so nothing could ever gate',
    );
  }
  return Object.freeze({
    ...policy,
    category_denylist: Object.freeze([...policy.category_denylist]) as string[],
  });
}

function requirePaise(parsed: Partial<PolicyConfig>, key: keyof PolicyConfig): number {
  const value = parsed[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`policy.yaml: ${key} must be a non-negative integer number of paise`);
  }
  return value as number;
}

function requireCount(parsed: Partial<PolicyConfig>, key: keyof PolicyConfig): number {
  const value = parsed[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`policy.yaml: ${key} must be a non-negative integer`);
  }
  return value as number;
}

/** A count that must be at least 1: a cap of zero would deny every basket. */
function requirePositiveCount(parsed: Partial<PolicyConfig>, key: keyof PolicyConfig): number {
  const value = parsed[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`policy.yaml: ${key} must be an integer of at least 1`);
  }
  return value as number;
}

/** A ratio rather than an amount, so a fraction is legitimate here. */
function requireMultiple(parsed: Partial<PolicyConfig>, key: keyof PolicyConfig): number {
  const value = parsed[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`policy.yaml: ${key} must be a positive number`);
  }
  return value;
}

function requireStringList(parsed: Partial<PolicyConfig>, key: keyof PolicyConfig): string[] {
  const value = parsed[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`policy.yaml: ${key} must be a list of strings`);
  }
  return value as string[];
}

let cached: PolicyConfig | undefined;

export function getPolicy(): PolicyConfig {
  cached ??= loadPolicy();
  return cached;
}

/** Test seam: swap the process policy. */
export function setPolicy(policy: PolicyConfig | undefined): void {
  cached = policy;
}
