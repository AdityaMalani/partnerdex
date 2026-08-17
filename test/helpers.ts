import { closeDb, getDb } from '../src/db/index.js';
import { resetConfig } from '../src/config.js';
import { insertAppEvents, insertTransactions } from '../src/sync/ingest.js';
import { rebuildDerivedTables } from '../src/sync/derive.js';
import type { AppEventNode, TransactionNode } from '../src/sync/ingest.js';

/**
 * Test fixtures build the store through the real ingest and derive paths, so a
 * test exercises the same normalization the sync does rather than a
 * hand-written subscriptions row.
 */

export const APP_ID = '111';
export const APP_GID = `gid://partners/App/${APP_ID}`;

export function resetEnvironment(overrides: Record<string, string> = {}): void {
  closeDb();
  resetConfig();
  process.env.PARTNER_API_TOKEN = 'test-token';
  process.env.PARTNER_ORGANIZATION_ID = '999';
  process.env.PARTNER_API_VERSION = '2026-07';
  process.env.PARTNER_APP_IDS = APP_ID;
  process.env.DATABASE_PATH = ':memory:';
  // Explicitly off, so a password exported in the developer's shell cannot
  // decide whether the fixture's API is gated. The auth tests override it.
  process.env.DASHBOARD_PASSWORD = '';
  // `createApp` refuses to build an ungated server without this — a missing
  // password is otherwise indistinguishable from a secret that failed to
  // deploy. A test fixture is exactly the "I mean it" case the flag is for.
  process.env.ALLOW_NO_AUTH = 'true';
  process.env.SYNC_START_DATE = '2020-01-01';
  process.env.REPORTING_TIMEZONE = 'UTC';
  process.env.CACHE_TTL_SECONDS = '0';
  process.env.METRICS_INCLUDE_ANNUAL = 'true';
  process.env.METRICS_INCLUDE_USAGE = 'false';
  process.env.METRICS_INCLUDE_TRIALS = 'false';
  process.env.METRICS_BY_SHOP = 'false';
  process.env.TRIAL_MIN_GAP_DAYS = '2';
  process.env.CHURN_WINDOW_DAYS = '30';
  process.env.CHURN_ON_UNINSTALL = 'true';
  process.env.PLAN_CHANGE_WINDOW_DAYS = '2';
  // Off by default, because every fixture in the suite is dated 2024 and would
  // otherwise be too old to announce. The cap has its own tests, which set it
  // explicitly and supply a clock.
  process.env.NOTIFICATION_MAX_AGE_HOURS = '0';
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  resetConfig();
}

function shop(id: string) {
  return { id: `gid://partners/Shop/${id}`, name: `Shop ${id}`, myshopifyDomain: `s${id}.example` };
}

export interface SubscriptionFixture {
  chargeRef: string;
  shopId: string;
  amount: number;
  /** ISO date of the activation event. */
  activatedAt: string;
  /** ISO date of the first paid charge; omit for a subscription never billed. */
  firstSaleAt?: string;
  churnedAt?: string;
  frozenAt?: string;
  unfrozenAt?: string;
  billingInterval?: 'EVERY_30_DAYS' | 'ANNUAL';
  billingOn?: string;
  test?: boolean;
  /** Extra paid charges after the first, for revenue tests. */
  extraSales?: Array<{ at: string; gross: number }>;
}

export interface RelationshipEvent {
  shopId: string;
  at: string;
}

export function seed(
  fixtures: SubscriptionFixture[],
  extra: {
    uninstalls?: RelationshipEvent[];
    installs?: RelationshipEvent[];
    /** The shop was closed or paused: the app goes away without an uninstall. */
    closes?: RelationshipEvent[];
    /** The shop reopened. The app is live again, and nobody chose it. */
    reopens?: RelationshipEvent[];
  } = {},
) {
  const db = getDb();

  const events: AppEventNode[] = [];
  const transactions: TransactionNode[] = [];

  for (const fixture of fixtures) {
    const charge = {
      id: `gid://shopify/AppSubscription/${fixture.chargeRef}`,
      name: 'Plan',
      test: fixture.test ?? false,
      billingOn: fixture.billingOn ?? null,
      amount: { amount: String(fixture.amount), currencyCode: 'USD' },
    };

    events.push({
      type: 'SUBSCRIPTION_CHARGE_ACTIVATED',
      occurredAt: fixture.activatedAt,
      __typename: 'SubscriptionChargeActivated',
      shop: shop(fixture.shopId),
      charge,
    });

    if (fixture.churnedAt) {
      events.push({
        type: 'SUBSCRIPTION_CHARGE_CANCELED',
        occurredAt: fixture.churnedAt,
        __typename: 'SubscriptionChargeCanceled',
        shop: shop(fixture.shopId),
        charge,
      });
    }
    if (fixture.frozenAt) {
      events.push({
        type: 'SUBSCRIPTION_CHARGE_FROZEN',
        occurredAt: fixture.frozenAt,
        __typename: 'SubscriptionChargeFrozen',
        shop: shop(fixture.shopId),
        charge,
      });
    }
    if (fixture.unfrozenAt) {
      events.push({
        type: 'SUBSCRIPTION_CHARGE_UNFROZEN',
        occurredAt: fixture.unfrozenAt,
        __typename: 'SubscriptionChargeUnfrozen',
        shop: shop(fixture.shopId),
        charge,
      });
    }

    const sales = [
      ...(fixture.firstSaleAt ? [{ at: fixture.firstSaleAt, gross: fixture.amount }] : []),
      ...(fixture.extraSales ?? []),
    ];
    sales.forEach((sale, index) => {
      transactions.push({
        id: `gid://partners/AppSubscriptionSale/${fixture.chargeRef}-${index}`,
        createdAt: sale.at,
        __typename: 'AppSubscriptionSale',
        app: { id: APP_GID, name: 'Test App' },
        shop: shop(fixture.shopId),
        chargeId: `gid://shopify/AppSubscription/${fixture.chargeRef}`,
        billingInterval: fixture.billingInterval ?? 'EVERY_30_DAYS',
        grossAmount: { amount: String(sale.gross), currencyCode: 'USD' },
        netAmount: { amount: String(sale.gross * 0.85), currencyCode: 'USD' },
        shopifyFee: { amount: String(sale.gross * 0.15), currencyCode: 'USD' },
      });
    });
  }

  for (const install of extra.installs ?? []) {
    events.push({
      type: 'RELATIONSHIP_INSTALLED',
      occurredAt: install.at,
      __typename: 'RelationshipInstalled',
      shop: shop(install.shopId),
      charge: null,
    });
  }

  for (const uninstall of extra.uninstalls ?? []) {
    events.push({
      type: 'RELATIONSHIP_UNINSTALLED',
      occurredAt: uninstall.at,
      __typename: 'RelationshipUninstalled',
      shop: shop(uninstall.shopId),
      charge: null,
    });
  }

  for (const close of extra.closes ?? []) {
    events.push({
      type: 'RELATIONSHIP_DEACTIVATED',
      occurredAt: close.at,
      __typename: 'RelationshipDeactivated',
      shop: shop(close.shopId),
      charge: null,
    });
  }

  for (const reopen of extra.reopens ?? []) {
    events.push({
      type: 'RELATIONSHIP_REACTIVATED',
      occurredAt: reopen.at,
      __typename: 'RelationshipReactivated',
      shop: shop(reopen.shopId),
      charge: null,
    });
  }

  insertAppEvents(db, APP_ID, events);
  insertTransactions(db, transactions);
  rebuildDerivedTables(db);
  return db;
}

export function pointAt(response: { timeSeries: Array<{ value: number; periodStart: string }> }, date: string): number {
  const point = response.timeSeries.find((entry) => entry.periodStart.startsWith(date));
  if (!point) throw new Error(`No bucket starting ${date}. Got: ${response.timeSeries.map((p) => p.periodStart).join(', ')}`);
  return point.value;
}

/**
 * Seeds one live paid subscription for an arbitrary app id, so tests can build a
 * shop that subscribes to more than one app.
 */
export function seedForApp(appId: string, chargeRef: string, shopId = '10') {
  const db = getDb();
  const charge = {
    id: `gid://shopify/AppSubscription/${chargeRef}`,
    name: 'Plan',
    test: false,
    billingOn: null,
    amount: { amount: '25', currencyCode: 'USD' },
  };
  insertAppEvents(db, appId, [
    {
      type: 'SUBSCRIPTION_CHARGE_ACTIVATED',
      occurredAt: '2024-01-05T00:00:00Z',
      __typename: 'SubscriptionChargeActivated',
      shop: shop(shopId),
      charge,
    },
  ]);
  insertTransactions(db, [
    {
      id: `gid://partners/AppSubscriptionSale/${chargeRef}`,
      createdAt: '2024-01-05T00:00:00Z',
      __typename: 'AppSubscriptionSale',
      app: { id: `gid://partners/App/${appId}`, name: `App ${appId}` },
      shop: shop(shopId),
      chargeId: `gid://shopify/AppSubscription/${chargeRef}`,
      billingInterval: 'EVERY_30_DAYS',
      grossAmount: { amount: '25', currencyCode: 'USD' },
      netAmount: { amount: '21', currencyCode: 'USD' },
      shopifyFee: { amount: '4', currencyCode: 'USD' },
    },
  ]);
  rebuildDerivedTables(db);
  return db;
}
