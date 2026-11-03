import { getConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { getDb } from '../db/index.js';
import { resolveScopedAppIds } from '../sync/index.js';

/**
 * Shared write path for live ingest and the contacts CSV import.
 *
 * Email is the natural key. Normalization, shop matching, and the rule that a
 * human `manual` link is never overwritten all live here so the two callers
 * cannot drift apart.
 */

export type ContactSource = 'app_capture' | 'csv_import';
export type ContactRole = 'owner' | 'staff' | 'collaborator';
export type MatchMethod = 'auto' | 'manual' | 'ambiguous' | 'none';

export class ContactsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'ContactsError';
  }
}

export interface UpsertContactInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  shop: {
    appId: string;
    shopId?: string | null;
    myshopifyDomain?: string | null;
  };
  role?: ContactRole;
  source: ContactSource;
  /** ISO timestamp. Backfill leaves first/last seen NULL when omitted. */
  seenAt?: string | null;
}

export interface UpsertContactResult {
  matched: MatchMethod;
  created: boolean;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Fold a domain (or pasted URL) into the form PartnerDex stores on shops:
 * lowercase host, no scheme/path/port. "Https://Foo.myshopify.com/" →
 * "foo.myshopify.com".
 */
export function normalizeDomain(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (!value) return '';
  value = value.replace(/^https?:\/\//, '');
  value = value.split('/')[0] ?? value;
  value = value.split('?')[0] ?? value;
  value = value.split(':')[0] ?? value;
  return value;
}

export function assertAppInScope(appId: string, db: Db = getDb()): void {
  const configured = getConfig().scope.appIds;
  if (configured.length > 0) {
    if (!configured.includes(appId)) {
      throw new ContactsError(
        `App id "${appId}" is outside the configured reporting scope (PARTNER_APP_IDS).`,
        403,
      );
    }
    return;
  }
  // Empty PARTNER_APP_IDS means org-wide. Prefer the resolved set when the
  // apps table is populated; otherwise accept any non-empty id (first capture
  // before the first sync has listed apps).
  const scoped = resolveScopedAppIds(db);
  if (scoped.length > 0 && !scoped.includes(appId)) {
    throw new ContactsError(
      `App id "${appId}" is outside the configured reporting scope.`,
      403,
    );
  }
}

export interface ShopMatch {
  shopId: string | null;
  matched: MatchMethod;
}

/**
 * Resolve a shop for a contact link.
 *
 * - Explicit shopId → auto (caller already knows the shop).
 * - Domain → lookup on shops.myshopify_domain: 1 = auto, many = ambiguous
 *   (best-guess = lowest shop id), 0 = none (no link written).
 */
export function resolveShopMatch(
  db: Db,
  shop: UpsertContactInput['shop'],
): ShopMatch {
  const explicit = shop.shopId?.trim() ?? '';
  if (explicit) {
    return { shopId: explicit, matched: 'auto' };
  }

  const domain = normalizeDomain(shop.myshopifyDomain ?? '');
  if (!domain) {
    return { shopId: null, matched: 'none' };
  }

  const rows = db
    .prepare(
      `SELECT id FROM shops
        WHERE lower(trim(myshopify_domain)) = ?
        ORDER BY id`,
    )
    .all(domain) as Array<{ id: string }>;

  if (rows.length === 0) return { shopId: null, matched: 'none' };
  if (rows.length === 1) return { shopId: rows[0]!.id, matched: 'auto' };
  return { shopId: rows[0]!.id, matched: 'ambiguous' };
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function upsertContact(
  input: UpsertContactInput,
  db: Db = getDb(),
): UpsertContactResult {
  const email = normalizeEmail(input.email);
  if (!email || !email.includes('@')) {
    throw new ContactsError('email is required and must look like an email address.', 422);
  }

  const appId = input.shop.appId?.trim() ?? '';
  if (!appId) {
    throw new ContactsError('shop.appId is required.', 422);
  }
  assertAppInScope(appId, db);

  const source = input.source;
  if (source !== 'app_capture' && source !== 'csv_import') {
    throw new ContactsError(`source must be app_capture or csv_import, got "${source}".`, 422);
  }

  const role: ContactRole = input.role ?? 'staff';
  if (role !== 'owner' && role !== 'staff' && role !== 'collaborator') {
    throw new ContactsError(`role must be owner, staff, or collaborator, got "${role}".`, 422);
  }

  const firstName = nonEmpty(input.firstName);
  const lastName = nonEmpty(input.lastName);
  const seenAt = nonEmpty(input.seenAt);
  const now = new Date().toISOString();
  // PartnerDex owns created_at: stamp it once on insert. iziGift cannot know
  // whether the row exists, so it sends seenAt (identification time) and we
  // use that on first insert. CSV import sends no seenAt — stamp import time.
  // Later upserts never overwrite created_at.
  const createdAt = seenAt ?? now;

  const existing = db
    .prepare('SELECT email FROM contacts WHERE email = ?')
    .get(email) as { email: string } | undefined;
  const created = !existing;

  db.prepare(
    `INSERT INTO contacts (
       email, first_name, last_name, is_suppressed, source,
       first_seen_at, last_seen_at, created_at, updated_at
     ) VALUES (
       @email, @firstName, @lastName, 0, @source,
       @firstSeen, @lastSeen, @createdAt, @now
     )
     ON CONFLICT(email) DO UPDATE SET
       first_name = CASE
         WHEN excluded.first_name IS NOT NULL AND excluded.first_name <> ''
         THEN excluded.first_name ELSE contacts.first_name END,
       last_name = CASE
         WHEN excluded.last_name IS NOT NULL AND excluded.last_name <> ''
         THEN excluded.last_name ELSE contacts.last_name END,
       last_seen_at = CASE
         WHEN excluded.last_seen_at IS NOT NULL THEN excluded.last_seen_at
         ELSE contacts.last_seen_at END,
       first_seen_at = CASE
         WHEN contacts.first_seen_at IS NULL AND excluded.first_seen_at IS NOT NULL
         THEN excluded.first_seen_at ELSE contacts.first_seen_at END,
       updated_at = excluded.updated_at`,
  ).run({
    email,
    firstName,
    lastName,
    source,
    firstSeen: seenAt,
    lastSeen: seenAt,
    createdAt,
    now,
  });

  const match = resolveShopMatch(db, input.shop);

  if (match.shopId) {
    const prior = db
      .prepare(
        `SELECT match_method FROM contact_shops
          WHERE email = ? AND app_id = ? AND shop_id = ?`,
      )
      .get(email, appId, match.shopId) as { match_method: string } | undefined;

    if (prior?.match_method === 'manual') {
      // Human decision outranks the importer and the endpoint.
      return { matched: 'manual', created };
    }

    db.prepare(
      `INSERT INTO contact_shops (
         email, app_id, shop_id, role, match_method, first_seen_at, last_seen_at
       ) VALUES (
         @email, @appId, @shopId, @role, @matched, @firstSeen, @lastSeen
       )
       ON CONFLICT(email, app_id, shop_id) DO UPDATE SET
         role = excluded.role,
         match_method = excluded.match_method,
         last_seen_at = CASE
           WHEN excluded.last_seen_at IS NOT NULL THEN excluded.last_seen_at
           ELSE contact_shops.last_seen_at END,
         first_seen_at = CASE
           WHEN contact_shops.first_seen_at IS NULL AND excluded.first_seen_at IS NOT NULL
           THEN excluded.first_seen_at ELSE contact_shops.first_seen_at END`,
    ).run({
      email,
      appId,
      shopId: match.shopId,
      role,
      matched: match.matched,
      firstSeen: seenAt,
      lastSeen: seenAt,
    });
  }

  return { matched: match.matched, created };
}

/** Email-global suppression — every contact row sharing the email is flipped. */
export function suppressContact(
  email: string,
  options: {
    source: 'resend_webhook' | 'manual' | 'csv_import';
    reason?: string | null;
    at?: string;
  },
  db: Db = getDb(),
): void {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  const at = options.at ?? new Date().toISOString();
  const stubSource: ContactSource =
    options.source === 'csv_import' ? 'csv_import' : 'app_capture';

  db.transaction(() => {
    db.prepare(
      `INSERT INTO contact_suppressions (email, suppressed_at, source, reason)
       VALUES (@email, @at, @source, @reason)
       ON CONFLICT(email) DO UPDATE SET
         suppressed_at = excluded.suppressed_at,
         source = excluded.source,
         reason = COALESCE(excluded.reason, contact_suppressions.reason)`,
    ).run({
      email: normalized,
      at,
      source: options.source,
      reason: options.reason ?? null,
    });

    db.prepare(
      `UPDATE contacts
          SET is_suppressed = 1, updated_at = @at
        WHERE email = @email`,
    ).run({ email: normalized, at });

    // Suppression can arrive before the contact row (import order). Ensure a
    // stub contact exists so is_suppressed has somewhere to live for the
    // send-list filter — only if no row yet.
    const exists = db
      .prepare('SELECT 1 AS ok FROM contacts WHERE email = ?')
      .get(normalized) as { ok: number } | undefined;
    if (!exists) {
      db.prepare(
        `INSERT INTO contacts (
           email, first_name, last_name, is_suppressed, source,
           first_seen_at, last_seen_at, created_at, updated_at
         ) VALUES (?, NULL, NULL, 1, ?, NULL, NULL, ?, ?)`,
      ).run(normalized, stubSource, at, at);
    }
  })();
}

/**
 * A human's answer for which store a contact belongs to.
 *
 * Writes `match_method = 'manual'`, which `upsertContact` will not overwrite —
 * the same rule `setReviewShop` uses for reviews. An `ambiguous` guess for the
 * same app is replaced rather than kept alongside the correction. Other
 * memberships (a person who already manages two stores) stay put.
 */
export function matchContactToShop(
  email: string,
  input: { shopId: string; appId?: string },
  db: Db = getDb(),
): { email: string; shopId: string; appId: string; matchMethod: 'manual' } {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@')) {
    throw new ContactsError('email is required and must look like an email address.', 422);
  }

  const contact = db.prepare('SELECT email FROM contacts WHERE email = ?').get(normalized) as
    | { email: string }
    | undefined;
  if (!contact) {
    throw new ContactsError(`No contact with email ${normalized}.`, 404);
  }

  const shopId = input.shopId?.trim() ?? '';
  if (!shopId) {
    throw new ContactsError('shopId is required.', 422);
  }
  const shop = db.prepare('SELECT id FROM shops WHERE id = ?').get(shopId) as
    | { id: string }
    | undefined;
  if (!shop) {
    throw new ContactsError(`No shop with id ${shopId}.`, 400);
  }

  const appId = resolveMatchAppId(db, normalized, input.appId);
  assertAppInScope(appId, db);

  const now = new Date().toISOString();
  db.transaction(() => {
    // The ambiguous row is the guess being replaced. Leave auto/manual links
    // to other shops: an agency email really can manage more than one store.
    db.prepare(
      `DELETE FROM contact_shops
        WHERE email = ? AND app_id = ? AND match_method = 'ambiguous' AND shop_id <> ?`,
    ).run(normalized, appId, shopId);

    db.prepare(
      `INSERT INTO contact_shops (
         email, app_id, shop_id, role, match_method, first_seen_at, last_seen_at
       ) VALUES (
         @email, @appId, @shopId, @role, 'manual', @now, @now
       )
       ON CONFLICT(email, app_id, shop_id) DO UPDATE SET
         match_method = 'manual',
         last_seen_at = excluded.last_seen_at`,
    ).run({
      email: normalized,
      appId,
      shopId,
      role: existingRole(db, normalized, appId, shopId),
      now,
    });
  })();

  return { email: normalized, shopId, appId, matchMethod: 'manual' };
}

function existingRole(db: Db, email: string, appId: string, shopId: string): ContactRole {
  const row = db
    .prepare(
      `SELECT role FROM contact_shops
        WHERE email = ? AND app_id = ? AND shop_id = ?`,
    )
    .get(email, appId, shopId) as { role: ContactRole } | undefined;
  if (row?.role === 'owner' || row?.role === 'staff' || row?.role === 'collaborator') {
    return row.role;
  }
  const any = db
    .prepare(`SELECT role FROM contact_shops WHERE email = ? AND app_id = ? LIMIT 1`)
    .get(email, appId) as { role: ContactRole } | undefined;
  if (any?.role === 'owner' || any?.role === 'staff' || any?.role === 'collaborator') {
    return any.role;
  }
  return 'staff';
}

function resolveMatchAppId(db: Db, email: string, requested?: string): string {
  const trimmed = requested?.trim() ?? '';
  if (trimmed) return trimmed;

  const scoped = resolveScopedAppIds(db);
  if (scoped.length === 1) return scoped[0]!;

  const linked = db
    .prepare(
      `SELECT app_id AS appId FROM contact_shops WHERE email = ? GROUP BY app_id ORDER BY app_id`,
    )
    .all(email) as Array<{ appId: string }>;
  const inScope = linked.filter((row) => scoped.includes(row.appId));
  if (inScope.length === 1) return inScope[0]!.appId;
  if (scoped.length === 0 && linked.length === 1) return linked[0]!.appId;

  throw new ContactsError(
    'appId is required when more than one app is in reporting scope.',
    422,
  );
}

/**
 * Lift a suppression. Deletes the durable row and mirrors `contacts.is_suppressed`,
 * so a later send-list read cannot see a stale flag with no matching register.
 */
export function unsuppressContact(email: string, db: Db = getDb()): void {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  const at = new Date().toISOString();

  const contact = db.prepare('SELECT email FROM contacts WHERE email = ?').get(normalized) as
    | { email: string }
    | undefined;
  if (!contact) {
    throw new ContactsError(`No contact with email ${normalized}.`, 404);
  }

  db.transaction(() => {
    db.prepare('DELETE FROM contact_suppressions WHERE email = ?').run(normalized);
    db.prepare(
      `UPDATE contacts
          SET is_suppressed = 0, updated_at = ?
        WHERE email = ?`,
    ).run(at, normalized);
  })();
}
