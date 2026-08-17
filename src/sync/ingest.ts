import type { Db } from '../db/index.js';
import { toUtcIso } from '../metrics/time.js';
import { markDirtyPairs, markSaleCharges } from './chargeIndex.js';
import { markTransactionEvents } from './events.js';
import { markTransactionDays } from './rollup.js';

/** `gid://partners/App/1234` -> `1234`. Bare ids pass through unchanged. */
export function gidTail(gid: string | null | undefined): string {
  if (!gid) return '';
  return gid.split('/').pop() ?? '';
}

export interface MoneyNode {
  amount: string | number | null;
  currencyCode: string | null;
}

export function money(node: MoneyNode | null | undefined): { amount: number; currency: string } {
  if (!node) return { amount: 0, currency: '' };
  const amount = Number(node.amount ?? 0);
  return {
    amount: Number.isFinite(amount) ? amount : 0,
    currency: node.currencyCode ?? '',
  };
}

export interface ShopNode {
  id: string;
  name: string | null;
  myshopifyDomain: string | null;
}

export interface AppNode {
  id: string;
  name: string;
  apiKey?: string | null;
}

export interface TransactionNode {
  id: string;
  createdAt: string;
  __typename: string;
  app?: AppNode | null;
  shop?: ShopNode | null;
  chargeId?: string | null;
  billingInterval?: string | null;
  grossAmount?: MoneyNode | null;
  netAmount?: MoneyNode | null;
  shopifyFee?: MoneyNode | null;
}

export interface AppEventNode {
  type: string;
  occurredAt: string;
  __typename: string;
  shop?: ShopNode | null;
  charge?: {
    id: string;
    name: string | null;
    test: boolean;
    billingOn: string | null;
    amount: MoneyNode | null;
  } | null;
}

export function upsertApp(db: Db, app: AppNode): string {
  const id = gidTail(app.id);
  if (!id) return '';
  db.prepare(
    `INSERT INTO apps (id, name, api_key, discovered_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       api_key = COALESCE(excluded.api_key, apps.api_key)`,
  ).run(id, app.name, app.apiKey ?? null, new Date().toISOString());
  return id;
}

export function upsertShop(db: Db, shop: ShopNode | null | undefined): string {
  const id = gidTail(shop?.id);
  if (!id || !shop) return '';
  db.prepare(
    `INSERT INTO shops (id, name, myshopify_domain)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = COALESCE(excluded.name, shops.name),
       myshopify_domain = COALESCE(excluded.myshopify_domain, shops.myshopify_domain)`,
  ).run(id, shop.name ?? null, shop.myshopifyDomain ?? null);
  return id;
}

export function insertTransactions(db: Db, nodes: TransactionNode[]): number {
  const statement = db.prepare(
    `INSERT INTO transactions (
       id, type, app_id, shop_id, charge_id, charge_ref, created_at,
       billing_interval, gross_amount, net_amount, shopify_fee, currency
     ) VALUES (
       @id, @type, @appId, @shopId, @chargeId, @chargeRef, @createdAt,
       @billingInterval, @grossAmount, @netAmount, @shopifyFee, @currency
     )
     ON CONFLICT(id) DO UPDATE SET
       gross_amount = excluded.gross_amount,
       net_amount = excluded.net_amount,
       shopify_fee = excluded.shopify_fee,
       billing_interval = COALESCE(excluded.billing_interval, transactions.billing_interval)`,
  );

  const run = db.transaction((batch: TransactionNode[]) => {
    let written = 0;
    /*
     * Days whose money changed, for the rollup to recompute.
     *
     * Collected per batch and written once rather than per row: a page of the
     * transaction feed covers a handful of days, so this is a few INSERTs
     * however many rows the page carries. UTC dates, because that is a `slice`
     * on a string already in hand — see `transaction_daily_dirty` in the schema.
     *
     * Marked on every write, not only on the ones that changed a figure. An
     * upsert here restates an existing row's amounts, and telling a restatement
     * that moved money from one that did not would mean reading the old row
     * back; recomputing a day that turned out to be unchanged costs
     * milliseconds, and missing one that did change is wrong forever.
     */
    const touchedDays = new Set<string>();
    /*
     * Charges whose settled sales moved, for `charge_sales` to recompute and
     * for the derived tables to find the merchant behind.
     *
     * Only `AppSubscriptionSale`, because that is the only type the aggregate
     * reads. A usage sale carries a charge ref of its own — millions of them in
     * this ledger — and marking those would put tens of thousands of charges no
     * subscription has ever heard of through the drain on every sync.
     */
    const touchedCharges = new Set<string>();
    /** Rows whose payment event has to be compiled or recompiled. */
    const touchedTransactions: string[] = [];
    for (const node of batch) {
      if (!node.app) continue; // non-app transactions (tax, referral) are out of scope
      const appId = upsertApp(db, node.app);
      const shopId = upsertShop(db, node.shop);
      const gross = money(node.grossAmount);
      const net = money(node.netAmount);
      const fee = money(node.shopifyFee);
      const createdAt = toUtcIso(node.createdAt);
      touchedDays.add(createdAt.slice(0, 10));
      const chargeRef = gidTail(node.chargeId);
      if (node.__typename === 'AppSubscriptionSale' && chargeRef) touchedCharges.add(chargeRef);
      touchedTransactions.push(node.id);

      statement.run({
        id: node.id,
        type: node.__typename,
        appId,
        shopId,
        chargeId: node.chargeId ?? '',
        chargeRef,
        createdAt,
        billingInterval: node.billingInterval ?? null,
        grossAmount: gross.amount,
        netAmount: net.amount,
        shopifyFee: fee.amount,
        currency: gross.currency || net.currency || fee.currency,
      });
      written += 1;
    }
    markTransactionDays(db, touchedDays);
    markSaleCharges(db, touchedCharges);
    markTransactionEvents(db, touchedTransactions);
    return written;
  });

  return run(nodes);
}

export function insertAppEvents(db: Db, appId: string, nodes: AppEventNode[]): number {
  const statement = db.prepare(
    `INSERT INTO app_events (
       app_id, shop_id, type, occurred_at, charge_id, charge_name,
       charge_amount, charge_currency, charge_test, billing_on
     ) VALUES (
       @appId, @shopId, @type, @occurredAt, @chargeId, @chargeName,
       @chargeAmount, @chargeCurrency, @chargeTest, @billingOn
     )
     ON CONFLICT(app_id, type, occurred_at, charge_id, shop_id) DO UPDATE SET
       charge_name = COALESCE(excluded.charge_name, app_events.charge_name),
       charge_amount = COALESCE(excluded.charge_amount, app_events.charge_amount),
       billing_on = COALESCE(excluded.billing_on, app_events.billing_on)`,
  );

  const run = db.transaction((batch: AppEventNode[]) => {
    let written = 0;
    /*
     * The merchants this batch wrote to, for the derived tables to rebuild.
     *
     * Marked on every write rather than only on writes that changed something,
     * for the reason `touchedDays` gives above: telling a correction that moved
     * a fact from one that did not would mean reading the old row back,
     * rebuilding a merchant that turned out to be unchanged costs milliseconds,
     * and missing one that did change is wrong until the next full rebuild.
     */
    const touchedShops = new Set<string>();
    for (const node of batch) {
      const shopId = upsertShop(db, node.shop);
      touchedShops.add(shopId);
      const charge = node.charge;
      const amount = money(charge?.amount);

      statement.run({
        appId,
        shopId,
        type: node.type,
        occurredAt: toUtcIso(node.occurredAt),
        chargeId: charge?.id ?? '',
        chargeName: charge?.name ?? null,
        chargeAmount: charge ? amount.amount : null,
        chargeCurrency: charge ? amount.currency : null,
        chargeTest: charge?.test ? 1 : 0,
        billingOn: charge?.billingOn ? toUtcIso(charge.billingOn) : null,
      });
      written += 1;
    }
    markDirtyPairs(db, appId, touchedShops);
    return written;
  });

  return run(nodes);
}
