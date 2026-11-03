import type { Db } from '../db/index.js';
import { getDb } from '../db/index.js';
import { shopDomainCoverage } from './import.js';

/**
 * Read-only check: is shops.myshopify_domain populated enough to trust the
 * contacts import's domain match? Thin coverage is a sync gap to fix, not a
 * reason to fall back to fuzzy name matching.
 */
export function reportDomainCoverage(db: Db = getDb()): {
  shopsTotal: number;
  shopsWithDomain: number;
  percent: number;
  sampleMissing: Array<{ id: string; name: string | null }>;
} {
  const { shopsTotal, shopsWithDomain } = shopDomainCoverage(db);
  const sampleMissing = db
    .prepare(
      `SELECT id, name FROM shops
        WHERE myshopify_domain IS NULL OR trim(myshopify_domain) = ''
        ORDER BY id
        LIMIT 10`,
    )
    .all() as Array<{ id: string; name: string | null }>;

  const percent = shopsTotal === 0 ? 0 : Math.round((shopsWithDomain / shopsTotal) * 1000) / 10;
  return { shopsTotal, shopsWithDomain, percent, sampleMissing };
}

export function formatDomainCoverage(report: ReturnType<typeof reportDomainCoverage>): string {
  const lines = [
    `shops.myshopify_domain coverage: ${report.shopsWithDomain}/${report.shopsTotal} (${report.percent}%)`,
  ];
  if (report.shopsTotal === 0) {
    lines.push('No shops in the store yet — run `partnerdex sync` before importing contacts.');
  } else if (report.percent < 80) {
    lines.push(
      'Coverage looks thin. Matching on myshopify_domain will leave many contacts unlinked.',
    );
    lines.push('Fix the Partner API sync gap before contacts:import --commit.');
  } else {
    lines.push('Coverage looks healthy for an import.');
  }
  if (report.sampleMissing.length > 0) {
    lines.push('Sample shops missing a domain:');
    for (const shop of report.sampleMissing) {
      lines.push(`  ${shop.id}  ${shop.name ?? '(no name)'}`);
    }
  }
  return lines.join('\n');
}
