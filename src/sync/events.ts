import type { Db } from '../db/index.js';
import { monthlyAmountFor } from './derive.js';

/**
 * Raw feed -> clean customer lifecycle events (customer-events spec 3).
 *
 * The Partner API's app-events feed is not a lifecycle. The same merchant
 * action shows up as several low-level facts, an upgrade arrives as *cancel the
 * old charge, activate a new one*, and nothing at all fires when a trial ends.
 * This module compiles that stream into the events a customer timeline and a
 * churn number actually want.
 *
 * Four rules shape the implementation:
 *
 *   1. **One timeline per install, folded in time order.** An activation cannot
 *      be classified in isolation: whether it is a subscribe, a win-back, an
 *      upgrade or a downgrade depends on what the shop was paying a moment
 *      earlier. The events the feed never sends — a trial converting, a loss the
 *      merchant expressed by uninstalling — are merged into that same timeline
 *      *before* the fold rather than appended after it, so the running balance
 *      sees every movement in the order it happened.
 *
 *   2. **`subscriptions` is the authority on money and on churn.** The cancel
 *      trap — "a lone cancel is usually a plan change, not a loss" — is already
 *      solved once in `derive.ts`, weighing cancels against plan changes,
 *      uninstalls and settlement lag. Re-deriving it here with a second window
 *      is exactly how an event timeline and a churn chart start disagreeing
 *      about the same merchant, so this module consumes that verdict.
 *
 *   3. **`net_change` is gated where MRR is gated.** MRR counts a subscription
 *      from its first paid charge, not its activation — a trial is live but
 *      worth nothing. An activation that opens a trial therefore carries a zero
 *      delta, and the money arrives later on `trial_converted`.
 *
 *   4. **The ledger balances.** Summing `net_change` over an install
 *      reconstructs its MRR contribution. `test/customerEvents.test.ts` asserts
 *      this against the MRR report itself, so the two cannot drift apart
 *      silently.
 *
 * Rebuilt wholesale on every sync. Ids are deterministic, so a rebuild
 * converges on the same rows rather than accumulating duplicates.
 */

/** The clean lifecycle vocabulary. Stable once anything reports on it. */
export const CUSTOMER_EVENT_TYPES = [
  // Account lifecycle
  'installed',
  'reinstalled',
  'uninstalled',
  'deactivated',
  'reactivated',
  // Subscription lifecycle
  'subscribed',
  'resubscribed',
  'upgraded',
  'downgraded',
  'unsubscribed',
  'subscription_frozen',
  'subscription_unfrozen',
  'charge_abandoned',
  'trial_abandoned',
  // Trial lifecycle (derived from dates; nothing in the feed fires at trial end)
  'trial_started',
  'trial_converted',
  'trial_expired',
  // Money
  'payment',
  'refund',
] as const;

export type CustomerEventType = (typeof CUSTOMER_EVENT_TYPES)[number];

/** States in which the install is paying nothing right now. */
const NON_PAYING_STATES = new Set<string>([
  'none',
  'installed',
  'reinstalled',
  'uninstalled',
  'unsubscribed',
  'subscription_frozen',
  'deactivated',
]);

/**
 * An `*_EXPIRED` event fires when Shopify finally gives up on a charge the
 * merchant never approved, days after the merchant actually walked away.
 * Back-dating it keeps abandonment next to the install it belongs to instead of
 * smearing it days later. Clamped to the install's first interaction, so it can
 * never sort before the shop existed.
 */
const EXPIRY_BACKDATE_HOURS = 60;

const MS_PER_HOUR = 3_600_000;

/**
 * Tie-break order for events sharing an instant. Ties are the plan-change case:
 * Shopify stamps the cancel of the old charge and the activation of the new one
 * at the same moment. Ordering the cancel first is what lets the fold read
 * "was paying X, now paying Y" instead of two unrelated entries.
 */
const ORDER: Record<string, number> = {
  RELATIONSHIP_INSTALLED: 0,
  RELATIONSHIP_REACTIVATED: 1,
  'derived:trial_started': 2,
  'derived:trial_converted': 3,
  SUBSCRIPTION_CHARGE_FROZEN: 4,
  'derived:trial_expired': 5,
  SUBSCRIPTION_CHARGE_CANCELED: 6,
  SUBSCRIPTION_CHARGE_EXPIRED: 6,
  SUBSCRIPTION_CHARGE_DECLINED: 6,
  'derived:unsubscribed': 6,
  SUBSCRIPTION_CHARGE_ACTIVATED: 7,
  SUBSCRIPTION_CHARGE_UNFROZEN: 8,
  RELATIONSHIP_DEACTIVATED: 9,
  RELATIONSHIP_UNINSTALLED: 10,
};

export interface RawEventRow {
  app_id: string;
  shop_id: string;
  type: string;
  occurred_at: string;
  charge_id: string;
  charge_name: string | null;
  charge_amount: number | null;
  charge_currency: string | null;
}

export interface SubRow {
  charge_id: string;
  app_id: string;
  shop_id: string;
  plan_name: string | null;
  currency: string | null;
  billing_interval: string;
  monthly_amount: number;
  activated_at: string | null;
  conversion_at: string | null;
  churn_at: string | null;
  churn_reason: string | null;
  trial_started_at: string | null;
  trial_ends_at: string | null;
  trial_status: string;
  is_plan_change: number;
}

export interface CleanEvent {
  event_id: string;
  app_id: string;
  shop_id: string;
  type: CustomerEventType;
  occurred_at: string;
  charge_id: string;
  prev_charge_id: string;
  plan_name: string | null;
  plan_amount: number | null;
  billing_interval: string | null;
  currency: string | null;
  net_change: number | null;
  amount: number | null;
  suppressed: number;
  detail: string | null;
}

/**
 * A position on an install's timeline: either a fact the feed sent, or one of
 * the movements it never sends and `subscriptions` had to resolve.
 */
interface TimelineItem {
  at: string;
  kind: string;
  raw: RawEventRow | null;
  sub: SubRow | null;
}

/**
 * Deterministic identity. The raw feed's natural key already uniquely names a
 * fact, so reusing it makes re-derivation idempotent for free. Derived items
 * namespace themselves and so can never collide with a compiled raw one.
 */
function rawEventId(row: RawEventRow): string {
  return `${row.app_id}|${row.shop_id}|${row.type}|${row.occurred_at}|${row.charge_id}`;
}

function derivedEventId(sub: SubRow, kind: string, at: string): string {
  return `${sub.app_id}|${sub.shop_id}|${kind}|${at}|${sub.charge_id}`;
}

/**
 * Unrecognized raw types are collected and reported, never thrown on.
 *
 * Accumulated across a whole pass rather than per call: the compiler runs once
 * per slice of merchants now, and reporting inside it would print the same line
 * hundreds of times for one unmapped type.
 */
const unknownTypes = new Set<string>();

/** Report and forget what this pass could not map. Called once, at the end. */
export function reportUnknownEventTypes(): void {
  if (unknownTypes.size === 0) return;
  console.warn(
    `[partnerdex] Skipped unmapped app event types: ${[...unknownTypes].sort().join(', ')}`,
  );
  unknownTypes.clear();
}

/**
 * What this subscription contributes to MRR at an instant. The gate is the
 * first paid charge, matching `asOfPredicate`, so a subscription still inside
 * its trial is worth nothing however live it looks.
 */
function contributionAt(sub: SubRow | undefined, at: string): number {
  if (!sub || sub.conversion_at === null) return 0;
  // A subscription that has already ended earns nothing, whatever lands
  // afterwards. The feeds are noisy well past a cancellation — a stray freeze,
  // a transaction settling months later — and without this a dead subscription
  // can be resurrected into MRR. Mirrors the churn clause in `asOfPredicate`.
  if (sub.churn_at !== null && sub.churn_at <= at) return 0;
  // A subscription with no trial still tends to have its first transaction
  // recorded a little after it activated — Partner transactions carry the date
  // they landed in a payout batch, not the date the merchant was charged.
  // `derive.ts` has already judged that gap too short to be a free period, so
  // the subscription was earning from activation and there is no later
  // conversion event to carry the money in.
  const gate =
    sub.trial_status === 'none' && sub.activated_at ? sub.activated_at : sub.conversion_at;
  return gate <= at ? sub.monthly_amount : 0;
}

function foldInstall(items: TimelineItem[], out: CleanEvent[]): void {
  let currentState = 'none';
  /** What the install is contributing to MRR right now. */
  let currentAmount = 0;
  /** The list price of the current plan, which labels upgrade vs downgrade. */
  let currentPlan = 0;
  let currentCharge = '';
  let everSubscribed = false;
  let everInstalled = false;

  const firstInteraction = items[0]?.at ?? null;

  for (const item of items) {
    const { raw, sub } = item;

    // Derived movements first: these are the events the feed never sends.
    if (!raw) {
      if (!sub) continue;
      const base = {
        app_id: sub.app_id,
        shop_id: sub.shop_id,
        occurred_at: item.at,
        charge_id: sub.charge_id,
        prev_charge_id: '',
        plan_name: sub.plan_name,
        plan_amount: sub.monthly_amount,
        billing_interval: sub.billing_interval,
        currency: sub.currency,
        net_change: null as number | null,
        amount: null as number | null,
        suppressed: 0,
        detail: null as string | null,
      };

      if (item.kind === 'derived:trial_started') {
        out.push({
          ...base,
          event_id: derivedEventId(sub, item.kind, item.at),
          type: 'trial_started',
          detail: JSON.stringify({ trialEndsAt: sub.trial_ends_at, status: sub.trial_status }),
        });
      } else if (item.kind === 'derived:trial_converted') {
        // The money the activation deliberately withheld arrives here. Skipped
        // when the install has already moved on to another charge, because then
        // this subscription is no longer the one earning.
        const applies = currentCharge === sub.charge_id;
        const credited = contributionAt(sub, item.at);
        out.push({
          ...base,
          event_id: derivedEventId(sub, item.kind, item.at),
          type: 'trial_converted',
          net_change: applies ? credited - currentAmount : 0,
        });
        if (applies) {
          currentAmount = credited;
          currentPlan = sub.monthly_amount;
        }
      } else if (item.kind === 'derived:trial_expired') {
        out.push({
          ...base,
          event_id: derivedEventId(sub, item.kind, item.at),
          type: 'trial_expired',
          plan_amount: 0,
        });
      } else if (item.kind === 'derived:unsubscribed') {
        // A loss the merchant expressed by uninstalling rather than cancelling,
        // so no cancel event exists to carry it.
        const applies = currentCharge === sub.charge_id;
        out.push({
          ...base,
          event_id: derivedEventId(sub, item.kind, item.at),
          type: 'unsubscribed',
          plan_amount: 0,
          net_change: applies ? -currentAmount : 0,
          detail: JSON.stringify({ churnReason: sub.churn_reason }),
        });
        if (applies) {
          currentAmount = 0;
          currentPlan = 0;
          currentCharge = '';
        }
        currentState = 'unsubscribed';
      }
      continue;
    }

    const interval = sub?.billing_interval ?? 'EVERY_30_DAYS';
    // The subscription index already normalized cadence; fall back to the raw
    // charge only for one that never made it in.
    const planAmount = sub ? sub.monthly_amount : monthlyAmountFor(raw.charge_amount ?? 0, interval);

    const base = {
      app_id: raw.app_id,
      shop_id: raw.shop_id,
      occurred_at: raw.occurred_at,
      charge_id: raw.charge_id,
      prev_charge_id: '',
      plan_name: sub?.plan_name ?? raw.charge_name,
      plan_amount: null as number | null,
      billing_interval: raw.charge_id ? interval : null,
      currency: sub?.currency ?? raw.charge_currency,
      net_change: null as number | null,
      amount: null as number | null,
      suppressed: 0,
      detail: null as string | null,
    };

    const push = (type: CustomerEventType, patch: Partial<CleanEvent> = {}) => {
      out.push({ ...base, event_id: rawEventId(raw), type, ...patch });
    };

    switch (raw.type) {
      case 'RELATIONSHIP_INSTALLED': {
        push(everInstalled ? 'reinstalled' : 'installed');
        everInstalled = true;
        if (NON_PAYING_STATES.has(currentState)) currentState = 'installed';
        break;
      }

      case 'RELATIONSHIP_REACTIVATED':
        push('reactivated');
        break;

      case 'RELATIONSHIP_DEACTIVATED':
        push('deactivated');
        break;

      case 'RELATIONSHIP_UNINSTALLED': {
        push('uninstalled');
        currentState = 'uninstalled';
        break;
      }

      case 'SUBSCRIPTION_CHARGE_ACTIVATED': {
        const contribution = contributionAt(sub ?? undefined, raw.occurred_at);

        if (!NON_PAYING_STATES.has(currentState) && currentCharge !== raw.charge_id) {
          // Already on a subscription, and this is a different charge: Shopify
          // models a plan change as a new subscription, so this is the visible
          // half of one. Direction is read from the list prices — an equal
          // swap counts as an upgrade, by convention — while the delta is the
          // movement in what is actually being earned.
          const type: CustomerEventType = planAmount >= currentPlan ? 'upgraded' : 'downgraded';
          push(type, {
            prev_charge_id: currentCharge,
            plan_amount: planAmount,
            net_change: contribution - currentAmount,
          });
          currentState = type;
        } else {
          const type: CustomerEventType = everSubscribed ? 'resubscribed' : 'subscribed';
          push(type, {
            prev_charge_id: currentCharge && currentCharge !== raw.charge_id ? currentCharge : '',
            plan_amount: planAmount,
            net_change: contribution - currentAmount,
          });
          currentState = type;
        }

        currentAmount = contribution;
        currentPlan = planAmount;
        currentCharge = raw.charge_id;
        everSubscribed = true;
        break;
      }

      case 'SUBSCRIPTION_CHARGE_CANCELED':
      case 'SUBSCRIPTION_CHARGE_EXPIRED':
      case 'SUBSCRIPTION_CHARGE_DECLINED': {
        // A charge that never reached a paid state was abandoned, not churned:
        // there is no revenue to lose. Expiries are back-dated to where the
        // merchant actually stopped, clamped to their first interaction.
        if (!sub || sub.conversion_at === null) {
          let at = raw.occurred_at;
          if (raw.type === 'SUBSCRIPTION_CHARGE_EXPIRED') {
            const backdated = new Date(
              new Date(raw.occurred_at).getTime() - EXPIRY_BACKDATE_HOURS * MS_PER_HOUR,
            ).toISOString();
            at = firstInteraction && backdated < firstInteraction ? firstInteraction : backdated;
          }
          // Two very different merchants end up here, and flattening them into
          // one type loses the only distinction worth acting on: one installed
          // the app, ran it on a trial, and decided against it; the other never
          // got as far as a trial at all.
          //
          // The separator is spec 6.1's `canceled_during` — the charge ended
          // while the trial window was still open. A cancel landing *after* the
          // window has already been reported by `trial_expired`, so calling it
          // an abandoned trial too would announce the same trial ending twice.
          const duringTrial = Boolean(
            sub &&
              sub.activated_at &&
              sub.trial_status !== 'none' &&
              sub.trial_ends_at &&
              at < sub.trial_ends_at,
          );
          push(duringTrial ? 'trial_abandoned' : 'charge_abandoned', {
            occurred_at: at,
            plan_amount: planAmount,
          });
          break;
        }

        // The cancel trap, and the one place churn is decided.
        //
        // `derive.ts` has already resolved when — and whether — this
        // subscription was lost. A cancel counts as churn only when it *is*
        // that resolved instant. Two cases fall out, and both must be
        // suppressed or the same loss is recorded twice:
        //
        //   - `is_plan_change` — the cancel is one half of an upgrade, so
        //     counting it would report a merchant as lost and upgraded at once;
        //   - an uninstall already ended the subscription earlier, and the loss
        //     is carried by the derived event at that instant instead.
        //
        // The row is kept either way. Suppressed events are filtered out of
        // every default read, so the audit trail survives without the churn
        // number ever seeing them.
        if (sub.is_plan_change === 1 || sub.churn_at !== raw.occurred_at) {
          push('unsubscribed', {
            suppressed: 1,
            plan_amount: planAmount,
            net_change: 0,
            detail: JSON.stringify({
              suppressedAs:
                sub.is_plan_change === 1 ? 'plan_change' : (sub.churn_reason ?? 'not_churn'),
            }),
          });
          break;
        }

        const applies = currentCharge === raw.charge_id;
        push('unsubscribed', {
          plan_amount: 0,
          prev_charge_id: applies ? '' : currentCharge,
          net_change: applies ? -currentAmount : 0,
        });
        if (applies) {
          currentAmount = 0;
          currentPlan = 0;
          currentCharge = '';
        }
        currentState = 'unsubscribed';
        break;
      }

      case 'SUBSCRIPTION_CHARGE_FROZEN': {
        // Frozen means installed but billing nothing: MRR drops without the
        // subscription being lost.
        push('subscription_frozen', { plan_amount: 0, net_change: -currentAmount });
        currentAmount = 0;
        currentState = 'subscription_frozen';
        break;
      }

      case 'SUBSCRIPTION_CHARGE_UNFROZEN': {
        // Restores only what the freeze actually took away: a subscription
        // frozen while still trialling was contributing nothing, so thawing it
        // must not conjure revenue the freeze never removed.
        const restored = contributionAt(sub ?? undefined, raw.occurred_at);
        push('subscription_unfrozen', {
          plan_amount: planAmount,
          net_change: restored - currentAmount,
        });
        currentAmount = restored;
        currentPlan = planAmount;
        currentCharge = raw.charge_id;
        currentState = 'subscription_unfrozen';
        break;
      }

      default:
        unknownTypes.add(raw.type);
        break;
    }
  }
}

interface TransactionRow {
  id: string;
  type: string;
  app_id: string;
  shop_id: string;
  charge_ref: string;
  created_at: string;
  gross_amount: number;
  net_amount: number;
  currency: string;
}

/**
 * "Payment made" as its own event, taken straight from the money feed rather
 * than inferred from the lifecycle. `netAmount` rides along in the detail so a
 * customer's page can show both what the merchant paid and what actually landed
 * after Shopify's revenue share.
 *
 * These carry no `net_change`: cash received is not a change in the recurring
 * rate, and counting a monthly renewal as MRR growth would inflate every chart.
 */
function paymentEvents(rows: TransactionRow[], out: CleanEvent[]): void {
  for (const row of rows) {
    const refund = row.gross_amount < 0;
    out.push({
      // Deterministic, and the reason the payment half of this table can be
      // rebuilt incrementally: the id of an event is derivable from the
      // transaction alone, so "has this transaction been compiled yet" is a
      // question the store can answer without recompiling anything.
      event_id: `tx|${row.id}`,
      app_id: row.app_id,
      shop_id: row.shop_id,
      type: refund ? 'refund' : 'payment',
      occurred_at: row.created_at,
      charge_id: row.charge_ref,
      prev_charge_id: '',
      plan_name: null,
      plan_amount: null,
      billing_interval: null,
      currency: row.currency,
      net_change: null,
      amount: row.gross_amount,
      suppressed: 0,
      detail: JSON.stringify({ source: row.type, netAmount: row.net_amount }),
    });
  }
}

/** The movements the feed never sends, recovered from the resolved dates. */
function derivedItems(sub: SubRow): TimelineItem[] {
  const items: TimelineItem[] = [];
  const add = (kind: string, at: string | null) => {
    if (at) items.push({ at, kind, raw: null, sub });
  };

  const hasTrial = sub.trial_status !== 'none' && sub.trial_status !== 'unknown';

  // A charge replaced by a plan change never ran a trial of its own — the
  // merchant moved tier, they did not start and abandon a free period. It still
  // carries a nominal trial window, so announcing one would put three "trial
  // started / trial ended" pairs on the timeline for a single afternoon of
  // tier-shopping. Only the two annotations are dropped: `trial_converted`
  // carries money, and withholding it would leave the running balance wrong for
  // the whole stretch the subscription really was being paid for.
  if (hasTrial && sub.is_plan_change === 0) {
    add('derived:trial_started', sub.trial_started_at);
    // A trial expires only if it reached its end still running (spec 6.2). A
    // merchant who walked out mid-window did not sit through one — and dating
    // the expiry at the *scheduled* end, as this did unconditionally, put the
    // event days or weeks after they were already gone. That merchant is
    // reported by `trial_abandoned`, at the moment they actually left.
    const ranItsCourse =
      sub.trial_status === 'canceled' &&
      sub.trial_ends_at !== null &&
      sub.churn_at !== null &&
      sub.churn_at >= sub.trial_ends_at;
    if (ranItsCourse) add('derived:trial_expired', sub.trial_ends_at);
  }
  if (hasTrial && sub.trial_status === 'converted') {
    add('derived:trial_converted', sub.conversion_at);
  }
  // A subscription can convert without any trial at all; the money still has to
  // enter the ledger somewhere, and the activation covers that case itself.
  if (sub.churn_reason === 'uninstalled' && sub.conversion_at) {
    add('derived:unsubscribed', sub.churn_at);
  }
  return items;
}

/**
 * How many payment events are compiled and committed at a time.
 *
 * The whole point of the chunk. Compiling every transaction into one array and
 * writing it in one transaction cost 3.9 GB of RSS and a 2.3 GB WAL at 4.1M
 * transactions, measured — on a 2 GB machine that is not slow, it is an
 * out-of-memory kill, and it is why the derived tables were still empty in
 * production. At this size the pass holds a few megabytes and commits as it
 * goes.
 */
const PAYMENT_CHUNK = 25_000;

/**
 * Above this many marked transactions, compile every row instead.
 *
 * The marked path costs one seek per transaction and the full path costs one
 * sequential walk of the table, so past a few hundred thousand marks the seeks
 * lose. A first backfill marks every row it imports, so this is also what stops
 * the initial build from taking the slow road.
 */
const FULL_REBUILD_MARK_THRESHOLD = 250_000;

/**
 * The one way a compiled event reaches the table, shared by both halves.
 *
 * Every non-key column is refreshed, not a chosen subset. A compiled event is a
 * pure function of the raw rows behind it, so if those are corrected the event
 * has to move with them; no column here may keep an older reading than its
 * neighbours.
 *
 * The narrower list this replaces updated the type and net_change but not the
 * amount or the currency. That was harmless for exactly as long as the table was
 * emptied before every insert: nothing conflicted, so the clause never ran.
 * Rebuilding one merchant at a time makes the conflict the normal case for the
 * lifecycle half too, and a sale restated at a different gross would have
 * updated a row's type while leaving the money on it stale.
 */
export const CUSTOMER_EVENT_UPSERT = `INSERT INTO customer_events (
     event_id, app_id, shop_id, type, occurred_at, charge_id, prev_charge_id,
     plan_name, plan_amount, billing_interval, currency, net_change, amount,
     suppressed, detail
   ) VALUES (
     @event_id, @app_id, @shop_id, @type, @occurred_at, @charge_id, @prev_charge_id,
     @plan_name, @plan_amount, @billing_interval, @currency, @net_change, @amount,
     @suppressed, @detail
   )
   ON CONFLICT(event_id) DO UPDATE SET
     app_id = excluded.app_id,
     shop_id = excluded.shop_id,
     type = excluded.type,
     occurred_at = excluded.occurred_at,
     charge_id = excluded.charge_id,
     prev_charge_id = excluded.prev_charge_id,
     plan_name = excluded.plan_name,
     plan_amount = excluded.plan_amount,
     billing_interval = excluded.billing_interval,
     currency = excluded.currency,
     net_change = excluded.net_change,
     amount = excluded.amount,
     suppressed = excluded.suppressed,
     detail = excluded.detail`;

/**
 * Record that a transaction's payment event has to be compiled or recompiled.
 *
 * Called on every write, not only on writes that changed a figure, for the
 * reason `transaction_daily_dirty` gives: telling a restatement that moved money
 * from one that did not would mean reading the old row back, recompiling a row
 * that turned out to be unchanged is one upsert, and missing one that did change
 * is a figure that is never corrected at all.
 */
export function markTransactionEvents(db: Db, ids: Iterable<string>): void {
  const statement = db.prepare(
    'INSERT OR IGNORE INTO transaction_events_dirty (id) VALUES (?)',
  );
  for (const id of ids) statement.run(id);
}

/**
 * The payment half of the table, compiled from the transactions that moved.
 *
 * Returns how many events were written, not how many exist: in the steady state
 * this pass touches only the handful of transactions the sync just brought in.
 *
 * **How it finds its work.** A transaction is not immutable — `insertTransactions`
 * updates `gross_amount`, `net_amount` and `shopify_fee` in place, and the sync
 * re-reads behind its watermark on every run — so a correction can land on a row
 * that was already compiled, flipping a payment to a refund or moving the figure
 * in `detail`. Every write therefore marks its id in `transaction_events_dirty`,
 * insert and correction alike, and this compiles exactly what is marked.
 *
 * What that replaces was a walk of the *whole* table asking `customer_events`
 * whether each row had been compiled yet, widened by a rolling recheck window
 * for the corrections that walk could not see. At a few million transactions
 * that is a few million index probes on every sync to discover a few hundred
 * rows, and it was the single most expensive thing in this file.
 *
 * `full` forces every transaction to be recompiled, and so does a mark set large
 * enough that seeking to each one would cost more than one sequential pass. It
 * is what `rebuild` and `sync --full` ask for — the two commands whose job is to
 * distrust what is already stored — and what a first backfill gets for free.
 */
export function rebuildPaymentEvents(db: Db, full: boolean): number {
  const statement = db.prepare(CUSTOMER_EVENT_UPSERT);
  const marked = (
    db.prepare('SELECT COUNT(*) AS n FROM transaction_events_dirty').get() as { n: number }
  ).n;
  const sequential = full || marked > FULL_REBUILD_MARK_THRESHOLD;

  const write = db.transaction((rows: CleanEvent[]) => {
    for (const row of rows) statement.run(row);
  });

  let written = 0;

  if (sequential) {
    /*
     * Keyset pagination on the primary key rather than LIMIT/OFFSET, which would
     * re-walk the whole prefix for every chunk and turn one pass into a
     * quadratic one. `transactions` is WITHOUT ROWID on `id`, so
     * `id > @after ORDER BY id` is a seek into the table's own b-tree and each
     * chunk resumes exactly where the last stopped.
     */
    const select = db.prepare(
      `SELECT t.id, t.type, t.app_id, t.shop_id, t.charge_ref, t.created_at,
              t.gross_amount, t.net_amount, t.currency
         FROM transactions t
        WHERE t.id > @after AND t.shop_id <> '' AND t.gross_amount <> 0
        ORDER BY t.id
        LIMIT @chunk`,
    );

    let after = '';
    for (;;) {
      const batch = select.all({ after, chunk: PAYMENT_CHUNK }) as TransactionRow[];
      if (batch.length === 0) break;
      const events: CleanEvent[] = [];
      paymentEvents(batch, events);
      write(events);
      written += events.length;
      after = batch[batch.length - 1]!.id;
    }

    db.prepare('DELETE FROM transaction_events_dirty').run();
    return written;
  }

  /*
   * The marked path. Marks are dropped in the same transaction that writes the
   * events they asked for, so a pass that dies half way leaves the rest of the
   * work claimed and the next pass finishes it.
   */
  const take = db.prepare('SELECT id FROM transaction_events_dirty ORDER BY id LIMIT ?');
  const select = db.prepare(
    `SELECT t.id, t.type, t.app_id, t.shop_id, t.charge_ref, t.created_at,
            t.gross_amount, t.net_amount, t.currency
       FROM transactions t
      WHERE t.id = ? AND t.shop_id <> '' AND t.gross_amount <> 0`,
  );
  const clear = db.prepare('DELETE FROM transaction_events_dirty WHERE id = ?');
  /*
   * A marked transaction that no longer qualifies had an event and must lose it.
   * A sale refunded to a gross of zero is the case: the row stays in the ledger,
   * the filter above stops matching it, and without this its payment event would
   * outlive the payment. Cheap — one delete per mark that found nothing, which
   * in the ordinary sync is none of them.
   */
  const drop = db.prepare(`DELETE FROM customer_events WHERE event_id = 'tx|' || ?`);

  for (;;) {
    const ids = (take.all(PAYMENT_CHUNK) as Array<{ id: string }>).map((row) => row.id);
    if (ids.length === 0) break;

    const rows: TransactionRow[] = [];
    const gone: string[] = [];
    for (const id of ids) {
      const row = select.get(id) as TransactionRow | undefined;
      if (row) rows.push(row);
      else gone.push(id);
    }
    const events: CleanEvent[] = [];
    paymentEvents(rows, events);

    db.transaction(() => {
      for (const event of events) statement.run(event);
      for (const id of gone) drop.run(id);
      for (const id of ids) clear.run(id);
    })();

    written += events.length;
  }

  return written;
}

/**
 * Compile the lifecycle half of the clean event feed for one slice of merchants.
 *
 * Pure, and that is the point: every input is an argument, so "a merchant is a
 * rebuildable unit" is a property that can be read off the signature rather than
 * trusted. `subs` are that slice's subscription rows as `derive.ts` has just
 * derived them — not read back out of the table — which makes the ordering
 * dependency on the subscription index explicit instead of a comment.
 *
 * The payment half is not here. A payment event is a pure function of the one
 * transaction it was compiled from, so it is repaired per transaction rather
 * than per merchant; see `rebuildPaymentEvents`.
 */
export function compileLifecycle(subs: SubRow[], raw: RawEventRow[]): CleanEvent[] {
  const subsByCharge = new Map(subs.map((sub) => [sub.charge_id, sub]));

  // Build one timeline per install, merging the feed with the derived
  // movements, so a single ordered fold sees every change in sequence.
  const timelines = new Map<string, TimelineItem[]>();
  const at = (key: string): TimelineItem[] => {
    const existing = timelines.get(key);
    if (existing) return existing;
    const created: TimelineItem[] = [];
    timelines.set(key, created);
    return created;
  };

  for (const row of raw) {
    at(`${row.app_id} ${row.shop_id}`).push({
      at: row.occurred_at,
      kind: row.type,
      raw: row,
      sub: subsByCharge.get(row.charge_id) ?? null,
    });
  }
  for (const sub of subs) {
    const items = derivedItems(sub);
    if (items.length > 0) at(`${sub.app_id} ${sub.shop_id}`).push(...items);
  }

  const events: CleanEvent[] = [];
  for (const items of timelines.values()) {
    items.sort((a, b) => {
      if (a.at !== b.at) return a.at < b.at ? -1 : 1;
      return (ORDER[a.kind] ?? 99) - (ORDER[b.kind] ?? 99);
    });
    foldInstall(items, events);
  }

  return events;
}
