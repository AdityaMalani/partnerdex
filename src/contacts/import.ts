import fs from 'node:fs';
import type { Db } from '../db/index.js';
import { getDb } from '../db/index.js';
import { parseCsv } from './csv.js';
import {
  assertAppInScope,
  normalizeDomain,
  normalizeEmail,
  suppressContact,
  upsertContact,
  type ContactRole,
  type MatchMethod,
} from './upsert.js';

/**
 * One-time contacts CSV → PartnerDex contacts store.
 *
 * Preview by default; `--commit` writes. Backfilled first/last seen stay NULL
 * (honest unknown). Opt-outs are a `suppressed` column on the same CSV.
 */

/** Exact header names required in the contacts CSV (order does not matter). */
export const CONTACTS_CSV_HEADERS = [
  'email',
  'first_name',
  'last_name',
  'myshopify_domain',
  'role',
  'suppressed',
] as const;

export interface ImportOptions {
  csvPath: string;
  appId: string;
  commit?: boolean;
  db?: Db;
}

export interface ImportSummary {
  committed: boolean;
  rowsRead: number;
  uniqueEmails: number;
  contactsWritten: number;
  matchCounts: Record<MatchMethod, number>;
  roleCounts: Record<ContactRole, number>;
  unlinkedEmails: string[];
  suppressionMarked: number;
  coverage: {
    shopsTotal: number;
    shopsWithDomain: number;
    csvDomains: number;
    csvDomainsExactOne: number;
    csvDomainsAmbiguous: number;
    csvDomainsNone: number;
  };
}

export function assertContactsCsvHeaders(headers: string[]): void {
  const present = new Set(headers.map((header) => header.trim()));
  const missing = CONTACTS_CSV_HEADERS.filter((header) => !present.has(header));
  if (missing.length > 0) {
    throw new Error(
      `contacts:import CSV is missing required header(s): ${missing.join(', ')}. ` +
        `Required headers (exact names): ${CONTACTS_CSV_HEADERS.join(', ')}`,
    );
  }
}

export function parseRole(raw: string): ContactRole {
  const value = raw.trim().toLowerCase();
  if (value === 'owner' || value === 'staff' || value === 'collaborator') return value;
  throw new Error(
    `Invalid role "${raw.trim() || '(blank)'}". Use owner, staff, or collaborator.`,
  );
}

/** true / 1 / yes → suppressed; false / 0 / no / blank → not suppressed. */
export function parseSuppressed(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (!value || value === '0' || value === 'false' || value === 'no' || value === 'n') {
    return false;
  }
  if (value === '1' || value === 'true' || value === 'yes' || value === 'y') {
    return true;
  }
  throw new Error(
    `Invalid suppressed value "${raw.trim()}". Use true/false (or 1/0, yes/no).`,
  );
}

export function shopDomainCoverage(db: Db): { shopsTotal: number; shopsWithDomain: number } {
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN myshopify_domain IS NOT NULL AND trim(myshopify_domain) <> '' THEN 1 ELSE 0 END) AS with_domain
       FROM shops`,
    )
    .get() as { total: number; with_domain: number };
  return { shopsTotal: row.total, shopsWithDomain: row.with_domain ?? 0 };
}

export function importContacts(options: ImportOptions): ImportSummary {
  const db = options.db ?? getDb();
  const appId = options.appId.trim();
  assertAppInScope(appId, db);

  const text = fs.readFileSync(options.csvPath, 'utf8');
  const { headers, rows } = parseCsv(text);
  assertContactsCsvHeaders(headers);

  const matchCounts: Record<MatchMethod, number> = {
    auto: 0,
    ambiguous: 0,
    none: 0,
    manual: 0,
  };
  const roleCounts: Record<ContactRole, number> = {
    owner: 0,
    staff: 0,
    collaborator: 0,
  };
  const unlinkedEmails: string[] = [];
  const seenEmails = new Set<string>();

  type Pending = {
    email: string;
    firstName: string;
    lastName: string;
    domain: string;
    role: ContactRole;
    suppressed: boolean;
  };
  const pending: Pending[] = [];

  for (const row of rows) {
    const email = normalizeEmail(row.email ?? '');
    if (!email.includes('@')) continue;

    // Dedupe within the file — last row wins names/domain/role/suppression.
    const role = parseRole(row.role ?? '');
    const next: Pending = {
      email,
      firstName: (row.first_name ?? '').trim(),
      lastName: (row.last_name ?? '').trim(),
      domain: normalizeDomain(row.myshopify_domain ?? ''),
      role,
      suppressed: parseSuppressed(row.suppressed ?? ''),
    };

    const priorIdx = pending.findIndex((p) => p.email === email);
    if (priorIdx >= 0) {
      roleCounts[pending[priorIdx]!.role] -= 1;
      pending[priorIdx] = next;
    } else {
      pending.push(next);
    }
    roleCounts[role] += 1;
    seenEmails.add(email);
  }

  // Domain coverage against the live shops table (read-only; always computed).
  let csvDomainsExactOne = 0;
  let csvDomainsAmbiguous = 0;
  let csvDomainsNone = 0;
  const uniqueDomains = new Set(pending.map((p) => p.domain).filter(Boolean));
  for (const domain of uniqueDomains) {
    const n = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM shops WHERE lower(trim(myshopify_domain)) = ?`,
        )
        .get(domain) as { n: number }
    ).n;
    if (n === 0) csvDomainsNone += 1;
    else if (n === 1) csvDomainsExactOne += 1;
    else csvDomainsAmbiguous += 1;
  }
  const shopCoverage = shopDomainCoverage(db);

  const runUpserts = () => {
    for (const row of pending) {
      const result = upsertContact(
        {
          email: row.email,
          firstName: row.firstName || null,
          lastName: row.lastName || null,
          shop: { appId, myshopifyDomain: row.domain || null },
          role: row.role,
          source: 'csv_import',
          // Honest unknown — do not stamp import day as first_seen.
          seenAt: null,
        },
        db,
      );
      matchCounts[result.matched] += 1;
      if (result.matched === 'none') unlinkedEmails.push(row.email);
      if (row.suppressed) {
        suppressContact(row.email, { source: 'csv_import', reason: 'unsubscribed' }, db);
      }
    }
  };

  let contactsWritten = 0;
  const suppressionMarked = pending.filter((row) => row.suppressed).length;

  if (options.commit) {
    db.transaction(() => {
      runUpserts();
    })();
    contactsWritten = pending.length;
  } else {
    // Preview: resolve matches without writing, by dry-running via upsert
    // against a savepoint that rolls back — keeps one code path.
    db.exec('SAVEPOINT contacts_import_preview');
    try {
      runUpserts();
    } finally {
      db.exec('ROLLBACK TO contacts_import_preview');
      db.exec('RELEASE contacts_import_preview');
    }
  }

  return {
    committed: Boolean(options.commit),
    rowsRead: rows.length,
    uniqueEmails: seenEmails.size,
    contactsWritten,
    matchCounts,
    roleCounts,
    unlinkedEmails: [...new Set(unlinkedEmails)].sort(),
    suppressionMarked,
    coverage: {
      shopsTotal: shopCoverage.shopsTotal,
      shopsWithDomain: shopCoverage.shopsWithDomain,
      csvDomains: uniqueDomains.size,
      csvDomainsExactOne,
      csvDomainsAmbiguous,
      csvDomainsNone,
    },
  };
}

export function formatImportSummary(summary: ImportSummary): string {
  const lines: string[] = [];
  lines.push(summary.committed ? 'COMMITTED' : 'PREVIEW (no writes)');
  lines.push(`Rows read:        ${summary.rowsRead}`);
  lines.push(`Unique emails:    ${summary.uniqueEmails}`);
  if (summary.committed) {
    lines.push(`Contacts written: ${summary.contactsWritten}`);
  }
  lines.push(`Suppressions:     ${summary.suppressionMarked}`);
  lines.push('Match breakdown:');
  lines.push(`  auto       ${summary.matchCounts.auto}`);
  lines.push(`  ambiguous  ${summary.matchCounts.ambiguous}`);
  lines.push(`  none       ${summary.matchCounts.none}`);
  lines.push('Role counts:');
  for (const role of ['owner', 'staff', 'collaborator'] as const) {
    lines.push(`  ${role.padEnd(14)} ${summary.roleCounts[role]}`);
  }
  lines.push('Shop domain coverage:');
  lines.push(
    `  shops with myshopify_domain: ${summary.coverage.shopsWithDomain}/${summary.coverage.shopsTotal}`,
  );
  lines.push(
    `  CSV domains → exact one / ambiguous / none: ` +
      `${summary.coverage.csvDomainsExactOne} / ` +
      `${summary.coverage.csvDomainsAmbiguous} / ` +
      `${summary.coverage.csvDomainsNone}` +
      ` (of ${summary.coverage.csvDomains} unique)`,
  );
  if (summary.unlinkedEmails.length > 0 && summary.unlinkedEmails.length <= 25) {
    lines.push('Unlinked emails (kept, no contact_shops row):');
    for (const email of summary.unlinkedEmails) lines.push(`  ${email}`);
  } else if (summary.unlinkedEmails.length > 25) {
    lines.push(
      `Unlinked emails: ${summary.unlinkedEmails.length} (kept; no contact_shops row)`,
    );
  }
  return lines.join('\n');
}
