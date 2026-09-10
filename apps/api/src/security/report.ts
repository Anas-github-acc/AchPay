import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AdversarialReport,
  AttackCatalog,
  SecurityAttack,
  SecurityReport,
} from '@storefront/shared';
import { pool } from '../db/pool.js';

export type {
  AttackCatalog,
  AttackCatalogEntry,
  DefenceLayer,
  SecurityAttack,
  SecurityReport,
  Severity,
} from '@storefront/shared';

const REPORT_KEY = 'adversarial';
const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'data');
const catalogPath = join(dataDir, 'attack-catalog.json');

function readCatalog(): AttackCatalog {
  return JSON.parse(readFileSync(catalogPath, 'utf8')) as AttackCatalog;
}

/** Reads the latest report and catalog from Postgres, not the deployment filesystem. */
export async function getSecurityReport(): Promise<SecurityReport> {
  const { rows } = await pool.query<{
    report: AdversarialReport;
    catalog: AttackCatalog;
  }>('select report, catalog from security_reports where report_key = $1', [REPORT_KEY]);
  const row = rows[0];
  if (!row) throw new Error('No adversarial security report has been published yet');

  const attacks: SecurityAttack[] = row.report.attacks.map((attack) => ({
    ...attack,
    catalog: row.catalog[attack.id] ?? null,
  }));

  return {
    generated_at: row.report.generated_at,
    total: row.report.total,
    held: row.report.held,
    broken: row.report.broken,
    ledger_chain: row.report.ledger_chain,
    attacks,
    missing_catalog_entries: attacks.filter((a) => a.catalog === null).map((a) => a.id),
  };
}

/** Publishes the latest test result while retaining the local JSON artifact. */
export async function publishSecurityReport(report: AdversarialReport): Promise<void> {
  await pool.query(
    `insert into security_reports (report_key, report, catalog, generated_at)
     values ($1, $2::jsonb, $3::jsonb, $4)
     on conflict (report_key) do update set
       report = excluded.report,
       catalog = excluded.catalog,
       generated_at = excluded.generated_at,
       updated_at = now()`,
    [REPORT_KEY, JSON.stringify(report), JSON.stringify(readCatalog()), report.generated_at],
  );
}
