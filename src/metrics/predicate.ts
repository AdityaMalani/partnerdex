/**
 * The one definition of "which subscriptions were live at instant D".
 *
 * It sits in a module of its own because two very different pieces of code have
 * to agree on it exactly: the as-of reader in `asof.ts`, which evaluates it
 * against the raw table, and the snapshot builder in `sync/stockRollup.ts`,
 * which evaluates it once per day and stores the answer. A rollup that used a
 * predicate merely equivalent to the reader's would be a second definition of
 * live, and the two would drift the first time either was edited. Sharing the
 * source text is what makes the snapshot exact by construction rather than by
 * agreement.
 */

export interface AsOfOptions {
  /** Empty means every app currently in reporting scope. */
  appIds: string[];
  /** Fold annual plans in at 1/12 of their annual price. */
  includeAnnual: boolean;
  /** Gate on activation rather than first payment, so trials count. */
  includeTrials: boolean;
}

export interface Fragment {
  sql: string;
  params: Record<string, unknown>;
}

/**
 * A subscriber is a shop's relationship with one app, not the shop itself. A
 * merchant running two of your apps is two subscribers, which is how each app's
 * own numbers count them — and it means dropping one app registers as churn
 * rather than hiding behind the other.
 *
 * That the key carries `app_id` is also what lets the daily snapshot store one
 * distinct count per app and have the counts sum: two apps can never contribute
 * the same subscriber.
 */
export const SUBSCRIBER_KEY = "s.app_id || ' ' || s.shop_id";
export const COUNT_SUBSCRIBERS = `COUNT(DISTINCT ${SUBSCRIBER_KEY})`;

export function appFilter(appIds: string[], column: string, prefix: string): Fragment {
  if (appIds.length === 0) return { sql: '', params: {} };
  const params: Record<string, unknown> = {};
  const names = appIds.map((id, index) => {
    const name = `${prefix}${index}`;
    params[name] = id;
    return `@${name}`;
  });
  return { sql: `${column} IN (${names.join(', ')})`, params };
}

/**
 * The column that decides when a subscription starts counting.
 *
 * This is the whole of what `includeTrials` changes, and the reason the daily
 * snapshot keys on the flag instead of carrying it in a column: moving the gate
 * selects a different set of rows at the same instant, and neither set contains
 * the other.
 */
export function gateColumn(includeTrials: boolean): string {
  return includeTrials ? 's.activated_at' : 's.conversion_at';
}

/**
 * "Subscription s is live as of <asOfExpr>". The instant is passed as an
 * expression so the identical predicate serves a scalar lookup (`@asOf`), a
 * per-bucket join (`b.as_of`) and the snapshot builder's per-day join
 * (`d.as_of`) without being written three times.
 *
 * `asOfExpr` is a bucket's *exclusive* end, so the comparisons are half-open:
 * an event landing exactly on the boundary belongs to the next bucket, matching
 * how the flow metrics slice the same instant. Using `<=` on the gate instead
 * would credit a subscription that started at midnight on the 1st to the month
 * that just ended.
 *
 * Missing fields are meaningful (spec 2.2): a NULL churn_at means "never
 * churned", not "unknown". Testing `churn_at = NULL` instead would silently
 * empty out all of history.
 */
export function asOfPredicate(options: AsOfOptions, asOfExpr: string): Fragment {
  const clauses: string[] = ['s.is_test = 0'];
  const apps = appFilter(options.appIds, 's.app_id', 'app');
  if (apps.sql) clauses.push(apps.sql);

  // The MRR gate is the first real payment. Including trials moves the gate
  // back to activation, so a subscription still in its free period counts at
  // the price it will eventually pay.
  const gate = gateColumn(options.includeTrials);
  clauses.push(`${gate} IS NOT NULL`);
  clauses.push(`${gate} < ${asOfExpr}`);
  clauses.push(`(s.churn_at IS NULL OR s.churn_at >= ${asOfExpr})`);

  // A frozen subscription is still installed but bills nothing. Frozen wins
  // unless an unfreeze has already landed by the as-of instant.
  clauses.push(
    `NOT (s.frozen_at IS NOT NULL AND s.frozen_at < ${asOfExpr}
          AND (s.unfrozen_at IS NULL OR s.unfrozen_at <= s.frozen_at OR s.unfrozen_at >= ${asOfExpr}))`,
  );

  if (!options.includeAnnual) clauses.push(`s.billing_interval <> 'ANNUAL'`);

  return { sql: clauses.join('\n           AND '), params: apps.params };
}
