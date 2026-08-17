/**
 * The SQLite schema, applied idempotently on every open.
 *
 * Four roles, one file (the Partner API's volume comfortably fits SQLite):
 *   1. raw feeds        — `app_events`, `transactions` as returned by the API,
 *                         and `listing_events` as exported by GA4
 *   2. derived indexes  — `subscriptions`, `install_intervals`, normalized at
 *                         write time so read-time math is sums + date compares
 *   3. operational      — `sync_state`, `metric_cache`, `drift_snapshots`
 *   4. durable          — `notification_channels` and the two tables that decide
 *                         what has already been said and to whom; `app_reviews`,
 *                         which holds the only surviving copy of a review once
 *                         the App Store stops serving it; and the BigQuery
 *                         connection, whose credential nothing else can supply
 *   5. affiliate ledger — the `affiliate_*` cluster: who refers merchants, which
 *                         merchant each one referred, and what that has earned
 *
 * Roles 1 and 2 are disposable: both are rebuilt from the API on demand. Roles 4
 * and 5 hold the state that cannot be recovered by re-syncing, which is why
 * their tables are written to rather than rebuilt.
 *
 * Every timestamp column holds a canonical UTC ISO-8601 string, so lexical
 * comparison is chronological comparison and the as-of predicate is plain SQL.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- \`org_id\` is the Shopify Partner organization this app was synced from. One
-- instance can cover several, and an app id alone does not say which token
-- reaches it.
--
-- \`DEFAULT ''\` is load-bearing rather than tidy: this block is
-- \`CREATE TABLE IF NOT EXISTS\` re-run on every open, so on an existing database
-- the column only ever arrives through the \`ALTER TABLE\` in \`migrate()\`, and
-- SQLite's ADD COLUMN refuses a NOT NULL column with no default. The blank is
-- also what the backfill there looks for.
--
-- The index on it is NOT here. See \`migrate()\` — this block runs before
-- migrations on every open, so an index naming a column that a migration adds
-- takes the process down on every database that predates the column.
CREATE TABLE IF NOT EXISTS apps (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL DEFAULT '',
  name           TEXT NOT NULL,
  api_key        TEXT,
  discovered_at  TEXT NOT NULL
);

-- The Shopify Partner organizations this instance covers, and the credential
-- that opens each one.
--
-- A whole new table rather than columns on an existing one, which is what keeps
-- it out of the migration-ordering trap that the comment above describes:
-- \`CREATE TABLE IF NOT EXISTS\` creates it complete on a new database and on one
-- that predates it alike, so there is no version of this file where a column
-- here exists on one and not the other. \`migrate()\` therefore has nothing to add
-- for it, and no index below names a column that arrives late.
--
-- \`token\` holds a live Partner API credential in plaintext. That is a decision
-- with a written case behind it, and the case is in \`src/orgs/store.ts\` —
-- including what it does not protect against. The property enforced in code is
-- narrower and absolute: the token is write-only from outside the process.
--
-- \`disabled_at\` rather than a DELETE, because removing an organization must not
-- remove its data. See \`removeOrganization\`.
--
-- \`source\` records whether the row was seeded from \`PARTNER_ORG_<n>_*\` or
-- entered in the dashboard. It only ever moves from 'env' to 'manual': editing a
-- seeded row is what taking it over means.
CREATE TABLE IF NOT EXISTS organizations (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL DEFAULT '',
  token        TEXT NOT NULL DEFAULT '',
  token_hint   TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT 'manual',
  disabled_at  TEXT,
  checked_at   TEXT,
  check_note   TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shops (
  id                TEXT PRIMARY KEY,
  name              TEXT,
  myshopify_domain  TEXT
);

-- Raw app lifecycle events. The Partner API does not expose an event id, so the
-- natural key below is what makes re-syncing idempotent. Empty strings rather
-- than NULLs because SQLite treats NULLs as distinct inside a UNIQUE index.
CREATE TABLE IF NOT EXISTS app_events (
  app_id          TEXT NOT NULL,
  shop_id         TEXT NOT NULL DEFAULT '',
  type            TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  charge_id       TEXT NOT NULL DEFAULT '',
  charge_name     TEXT,
  charge_amount   REAL,
  charge_currency TEXT,
  charge_test     INTEGER NOT NULL DEFAULT 0,
  billing_on      TEXT,
  PRIMARY KEY (app_id, type, occurred_at, charge_id, shop_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_events_charge ON app_events (charge_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_app_shop ON app_events (app_id, shop_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON app_events (type, occurred_at);

CREATE TABLE IF NOT EXISTS transactions (
  id               TEXT PRIMARY KEY,
  type             TEXT NOT NULL,
  app_id           TEXT NOT NULL,
  shop_id          TEXT NOT NULL DEFAULT '',
  charge_id        TEXT NOT NULL DEFAULT '',
  -- Numeric tail of charge_id. Transactions and app events sometimes label the
  -- same recurring charge with different gid prefixes, so joins use this.
  charge_ref       TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL,
  billing_interval TEXT,
  gross_amount     REAL NOT NULL DEFAULT 0,
  net_amount       REAL NOT NULL DEFAULT 0,
  shopify_fee      REAL NOT NULL DEFAULT 0,
  currency         TEXT NOT NULL DEFAULT ''
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_tx_app_time ON transactions (app_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_charge ON transactions (charge_ref, type, created_at);
-- Money per period, by kind: gross earnings and the usage series both slice the
-- feed by type over a date range and then sum. \`(type, created_at)\` found those
-- rows and carried none of the figures, so every one of them cost a random seek
-- into a WITHOUT ROWID primary key — 3.9M of them for a year of usage revenue.
-- Carrying \`app_id\` (the filter) and the two amounts (the answer) makes both
-- queries index-only: 1.6s -> 0.6s, measured. A superset of the index it
-- replaces, which the migration step drops.
CREATE INDEX IF NOT EXISTS idx_tx_type_money
  ON transactions (type, created_at, app_id, gross_amount, net_amount);
CREATE INDEX IF NOT EXISTS idx_tx_shop_time ON transactions (app_id, shop_id, created_at);

-- Lifetime gross and net per merchant, which the customer list computes for
-- *every* shop before it can sort or page. \`idx_tx_shop_time\` finds the rows
-- but carries none of the money, and this table is WITHOUT ROWID, so each row
-- it found then cost a second random seek into the primary key. Carrying the
-- three summed columns in the index makes that aggregate index-only: 2.5s ->
-- 1.1s over 4.1M transactions, measured. It is the largest index here and it
-- earns that on the one query whose cost scales with the whole table on a
-- request thread.
CREATE INDEX IF NOT EXISTS idx_tx_shop_money
  ON transactions (app_id, shop_id, gross_amount, net_amount, currency);

-- Daily money rollup, derived from \`transactions\` and rebuilt by the sync.
--
-- Every transaction-based metric used to re-read the raw feed once per bucket:
-- gross earnings sums the whole ledger per bucket, the usage component of MRR
-- LEFT JOINs it on a trailing-30-day range per bucket, and the currency profile
-- scanned it outright. At millions of transactions that is a dozen passes over
-- the largest table in the database for a series a dozen points long. One row
-- per (day, type, app, currency) is four orders of magnitude smaller and answers
-- all three.
--
-- \`day\` is a calendar date in REPORTING_TIMEZONE, not UTC, because the buckets
-- these sums are read into are resolved in that zone. A UTC-keyed rollup summed
-- into local-time buckets would be wrong by up to a day's revenue at every seam.
-- The consequence is that the rollup belongs to one timezone setting:
-- \`syncTransactionDaily\` records which one it was built under and rebuilds from
-- scratch when that changes.
--
-- Money is stored the way the source stores it — one REAL per column — rather
-- than as integer cents, so that a sum of days is the same arithmetic on the
-- same values as a sum of rows and cannot introduce a unit conversion of its own.
--
-- Derived and disposable: \`DELETE FROM transaction_daily\` costs a rebuild and
-- nothing else. It is never the only copy of anything.
CREATE TABLE IF NOT EXISTS transaction_daily (
  day          TEXT NOT NULL,
  type         TEXT NOT NULL,
  app_id       TEXT NOT NULL,
  currency     TEXT NOT NULL DEFAULT '',
  gross_amount REAL NOT NULL DEFAULT 0,
  net_amount   REAL NOT NULL DEFAULT 0,
  shopify_fee  REAL NOT NULL DEFAULT 0,
  txn_count    INTEGER NOT NULL DEFAULT 0,
  -- \`day\` leads because every read is a date range; \`type\` next because both
  -- money reports filter on it. No secondary index: the whole table is small
  -- enough that the currency profile can scan it.
  PRIMARY KEY (day, type, app_id, currency)
) WITHOUT ROWID;

-- Which days the rollup owes a recomputation, in UTC dates.
--
-- Written by the ingest as transactions land, drained by the sync's rollup step.
-- UTC rather than reporting-local on purpose: marking a day costs a \`substr\` on
-- a string the ingest already holds, where the local date would cost an Intl
-- lookup per row on a backfill of millions. A UTC date spans at most two local
-- ones, so the drain widens each mark by a day on either side — recomputing a
-- day that did not change is free, missing one that did is a silent permanent
-- error in reported revenue.
--
-- This is what makes restatement safe. The Partner API re-serves and corrects
-- rows that have already been ingested; an upsert that changes an amount marks
-- its day here exactly as a first insert does, so the correction reaches the
-- rollup on the next sync instead of being averaged away forever.
CREATE TABLE IF NOT EXISTS transaction_daily_dirty (
  day TEXT PRIMARY KEY
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- The subscription-side rollups.
--
-- \`transaction_daily\` above rolls up a *flow*: a day's row is a sum of things
-- that happened inside the day, and a window is a sum of days. MRR is not that.
-- It is a *stock* — "which subscriptions were live at this instant" — and a
-- stock is not a sum of anything, so the same table shape cannot carry it.
--
-- A stock's rollup is therefore a snapshot rather than a subtotal: one row per
-- day recording the population as it stood at the instant that day opened. The
-- two tables below are those snapshots. Their day keys mean the same thing
-- \`transaction_daily\`'s do — a calendar date in REPORTING_TIMEZONE — but the
-- row is read at \`dayKeyStart(day)\` instead of summed over \`[day, day+1)\`.
--
-- The consequence, which is the whole design: a snapshot can only answer an
-- instant it actually holds. Bucket boundaries are local midnights, so the
-- interior boundaries of every window land exactly on a snapshot; the final
-- bucket ends at *now*, which does not, and falls back to the raw tables. See
-- \`metrics/stockRollup.ts\`.

-- The live subscription population at the midnight opening \`day\`.
--
-- \`gate\` is the as-of flag that cannot be answered by summing columns, so the
-- table keys on it instead. \`includeTrials\` swaps the predicate's gate from the
-- first paid charge to activation, which selects a *different population* — not
-- a superset and not a subset of the other, since a subscription's two gate
-- instants can straddle any given midnight. Two rows per day is the honest
-- shape; one row plus an adjustment would be a rollup that quietly answers one
-- flag combination when asked about another.
--   0 = gated on conversion_at (includeTrials = false)
--   1 = gated on activated_at  (includeTrials = true)
--
-- \`includeAnnual\`, by contrast, *is* answerable by columns, because it is a
-- filter on a row attribute rather than a change of predicate: the annual and
-- non-annual halves are stored apart and the reader adds the ones it wants.
--
-- Subscriber counts are stored twice for the reason the split cannot cover:
-- \`COUNT(DISTINCT shop)\` is not additive across the annual/non-annual split.
-- One shop holding both an annual and a monthly charge is one subscriber in the
-- total and would be two if the halves were added. It *is* additive across
-- \`app_id\`, because a subscriber is a shop-and-app pair, so no third column is
-- needed for the per-app scopes.
CREATE TABLE IF NOT EXISTS subscription_daily (
  day                 TEXT NOT NULL,
  gate                INTEGER NOT NULL,
  app_id              TEXT NOT NULL,
  monthly_mrr         REAL NOT NULL DEFAULT 0,
  annual_mrr          REAL NOT NULL DEFAULT 0,
  monthly_subs        INTEGER NOT NULL DEFAULT 0,
  annual_subs         INTEGER NOT NULL DEFAULT 0,
  subscribers_all     INTEGER NOT NULL DEFAULT 0,
  subscribers_monthly INTEGER NOT NULL DEFAULT 0,
  -- \`day\` leads because every read is a set of days; \`gate\` next because every
  -- read pins exactly one. No secondary index: a day's rows are a handful.
  PRIMARY KEY (day, gate, app_id)
) WITHOUT ROWID;

-- The stocks that no as-of flag touches, at the same midnights.
--
-- Active installs read \`install_intervals\` and trials read \`trial_started_at\` /
-- \`trial_ends_at\`; neither predicate mentions \`includeAnnual\` or
-- \`includeTrials\`, so keying these on \`gate\` would store the same number twice
-- and invite a reader to add them. They live beside \`subscription_daily\`
-- rather than inside it for exactly that reason.
CREATE TABLE IF NOT EXISTS population_daily (
  day             TEXT NOT NULL,
  app_id          TEXT NOT NULL,
  active_installs INTEGER NOT NULL DEFAULT 0,
  on_trial        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, app_id)
) WITHOUT ROWID;

-- Lifecycle movement per day: the flow half of logo churn.
--
-- This one *is* a \`transaction_daily\`-shaped rollup, because uninstalls and
-- reinstalls inside a window are a flow. It exists because \`customer_events\` is
-- the largest table in the database and logo churn crosses it once per bucket
-- with a rolling window, so twelve buckets read a month of it twelve times over.
--
-- Only \`suppressed = 0\` rows are counted, which is the filter every default
-- read applies; a suppressed event is a cancellation that turned out to be half
-- of a plan change, and it is excluded from the rollup for the same reason it is
-- excluded from the query the rollup replaces.
CREATE TABLE IF NOT EXISTS customer_event_daily (
  day         TEXT NOT NULL,
  app_id      TEXT NOT NULL,
  type        TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, type, app_id)
) WITHOUT ROWID;

-- The watermark the snapshot tables are repaired from.
--
-- A flow rollup's dirty mark is a *day*: a transaction that arrives late changes
-- its own day and no other. A snapshot's is a *floor*: a cancellation backdated
-- to March changes the live population at every midnight from March until now,
-- because the subscription is absent from all of them and was present before.
-- So this table is drained as \`MIN(day)\` and everything from there forward is
-- recomputed, rather than day by day.
--
-- In the ordinary case the floor is yesterday and the repair is two days wide.
-- A deep restatement widens it, and a restatement older than the table is a full
-- rebuild — which is the correct amount of work, not a fallback.
CREATE TABLE IF NOT EXISTS stock_daily_dirty (
  day TEXT PRIMARY KEY
) WITHOUT ROWID;

-- What the snapshot builder last saw, so it can tell what changed.
--
-- \`subscriptions\` and \`install_intervals\` are rebuilt wholesale by every sync:
-- they are DELETEd and reinserted, so "which rows changed" is not something the
-- writer can report without either an upsert path it does not have or a
-- comparison it does not do. This table is that comparison, kept where it is
-- used. One row per source row, holding a digest of the fields the snapshots
-- actually depend on and the earliest instant that row can affect.
--
-- Digesting only the load-bearing fields is deliberate: a plan being renamed
-- moves no snapshot, and marking it dirty would recompute history for nothing.
-- Every field the as-of predicate or the snapshot's SUMs read is in the digest,
-- so the converse — a change that moves a number and is not noticed — cannot
-- happen.
--
-- \`kind\` separates the two sources into one table because they are drained
-- together into one watermark and never queried apart.
CREATE TABLE IF NOT EXISTS stock_daily_seen (
  kind   TEXT NOT NULL,
  id     TEXT NOT NULL,
  digest TEXT NOT NULL,
  -- The earliest instant a change to this row can move a snapshot.
  since  TEXT NOT NULL,
  PRIMARY KEY (kind, id)
) WITHOUT ROWID;

-- ---------------------------------------------------------------------------
-- The charge index: what makes the three derived subscription tables
-- rebuildable one merchant at a time.
--
-- \`subscriptions\`, \`install_intervals\` and \`customer_events\` are
-- reconstructions rather than sums. A subscription's life, an install's span and
-- a lifecycle timeline are all produced by walking one merchant's events in
-- order, so the unit that can be invalidated is not a day — it is an
-- (app_id, shop_id) pair. Rebuilding one pair needs three things that a pair
-- cannot supply on its own, and the tables below are those three things,
-- maintained beside the pair so the rebuild never has to read the whole ledger
-- to find them.

-- The settled-sale aggregate per charge, lifted out of \`transactions\`.
--
-- \`buildSubscriptions\` needs, for each charge, when it first and last settled,
-- how many times, and what cadence the sale stated. Computing that inline is a
-- GROUP BY over every transaction ever ingested — millions of rows to answer a
-- question about the handful of charges a sync actually touched. Here it is a
-- table with one row per charge, and a sync recomputes only the charges whose
-- money moved.
--
-- Restatement-safe by the same rule as \`transaction_daily\`: a dirty charge is
-- recomputed from the raw rows rather than adjusted, so a correction applied
-- twice lands where applying it once lands, and a sale that disappears takes its
-- contribution with it.
CREATE TABLE IF NOT EXISTS charge_sales (
  charge_ref       TEXT PRIMARY KEY,
  first_sale_at    TEXT NOT NULL,
  last_sale_at     TEXT NOT NULL,
  paid_sale_count  INTEGER NOT NULL DEFAULT 0,
  billing_interval TEXT
) WITHOUT ROWID;

-- Which charges owe a recomputation of the aggregate above.
--
-- Written by the ingest for every \`AppSubscriptionSale\` it writes, insert and
-- correction alike, for the reason \`transaction_daily_dirty\` gives: telling a
-- restatement that moved money from one that did not would mean reading the old
-- row back, and missing one is wrong forever. Only that one type is marked
-- because it is the only type the aggregate reads; a usage sale carries its own
-- unique charge ref and would mark tens of thousands of charges per sync that
-- no subscription has ever heard of.
CREATE TABLE IF NOT EXISTS charge_sales_dirty (
  charge_ref TEXT PRIMARY KEY
) WITHOUT ROWID;

-- The raw charge dimension, folded out of \`app_events\` one row per charge.
--
-- The same GROUP BY \`buildSubscriptions\` used to run over the whole event feed
-- on every sync, kept instead, so a pass reads the charges of the merchants it
-- is rebuilding and nothing else. Every column here is a fact the feed stated;
-- nothing on this table is derived, which is what lets the price book below be
-- computed from it without a circular dependency on \`subscriptions\`.
--
-- \`billing_on\` and \`canceled_at\` are carried even though \`subscriptions\` does
-- not store them: the first is the only clock-sensitive input the derivation has
-- (see \`derive.ts\`), and the second is what the churn resolution starts from.
CREATE TABLE IF NOT EXISTS charge_facts (
  charge_id    TEXT PRIMARY KEY,
  charge_ref   TEXT NOT NULL DEFAULT '',
  app_id       TEXT NOT NULL,
  shop_id      TEXT NOT NULL DEFAULT '',
  plan_name    TEXT,
  amount       REAL,
  currency     TEXT,
  is_test      INTEGER NOT NULL DEFAULT 0,
  accepted_at  TEXT,
  activated_at TEXT,
  canceled_at  TEXT,
  frozen_at    TEXT,
  unfrozen_at  TEXT,
  billing_on   TEXT
) WITHOUT ROWID;

-- The pair lookup is the hot one: every rebuilt merchant reads its charges
-- through it.
CREATE INDEX IF NOT EXISTS idx_charge_facts_pair ON charge_facts (app_id, shop_id);
-- A sale names a charge ref, and the pair it belongs to has to be found from it.
CREATE INDEX IF NOT EXISTS idx_charge_facts_ref ON charge_facts (charge_ref);
-- The clock sweep: which charges crossed their next billing date since the last
-- pass. Without this it is a scan of every charge on every sync.
CREATE INDEX IF NOT EXISTS idx_charge_facts_billing ON charge_facts (billing_on);

-- The cadence learned per price point — the one input to the derivation that is
-- not local to a merchant.
--
-- \`resolveInterval\` falls back to "what cadence has this app's <plan, price>
-- been billed at elsewhere", which reads across every shop of the app. That is
-- the single reason a per-merchant rebuild is not obviously sound, so the book
-- is stored rather than recomputed in memory: a sync compares the book it just
-- computed against this one and marks every merchant holding a charge at a price
-- point whose answer moved. A book that did not move invalidates nobody.
--
-- \`key\` is \`priceKey()\`'s string verbatim, built by the same function on both
-- sides, so a stored key and a fresh one cannot disagree about rounding.
CREATE TABLE IF NOT EXISTS price_book (
  key              TEXT PRIMARY KEY,
  billing_interval TEXT NOT NULL
) WITHOUT ROWID;

-- Which transactions owe a payment event.
--
-- The payment half of \`customer_events\` is not a per-merchant reconstruction at
-- all: one row per transaction, each a pure function of the transaction it was
-- compiled from. It was already repaired incrementally, but the way it found its
-- work was a walk of every transaction ever ingested asking the event table
-- whether each one had been compiled yet — millions of index probes per sync to
-- discover the few hundred rows that had actually moved.
--
-- The ingest knows. Every write marks its id here, insert and correction alike,
-- and the sync compiles exactly what is marked. Above a threshold the marks are
-- abandoned for one sequential pass, which is what stops a first backfill taking
-- the slow road one seek at a time.
CREATE TABLE IF NOT EXISTS transaction_events_dirty (
  id TEXT PRIMARY KEY
) WITHOUT ROWID;

-- The merchants the derived tables owe a rebuild.
--
-- The durable work list, and the whole recovery story. Every step that discovers
-- a pair commits it here *before* doing anything that depends on having
-- discovered it, and the rebuild deletes a pair's mark in the same transaction
-- that rewrites the pair's rows. A pass that dies half way therefore leaves
-- exactly the merchants it did not finish still marked, and the next pass
-- finishes them; there is no state in which a merchant is quietly wrong.
CREATE TABLE IF NOT EXISTS derive_dirty_pairs (
  app_id  TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  PRIMARY KEY (app_id, shop_id)
) WITHOUT ROWID;

-- One row per subscription charge, rebuilt from app_events + transactions.
-- monthly_amount is the write-time normalized figure that MRR sums.
CREATE TABLE IF NOT EXISTS subscriptions (
  charge_id         TEXT PRIMARY KEY,
  charge_ref        TEXT NOT NULL DEFAULT '',
  app_id            TEXT NOT NULL,
  shop_id           TEXT NOT NULL DEFAULT '',
  plan_name         TEXT,
  amount            REAL NOT NULL DEFAULT 0,
  currency          TEXT,
  billing_interval  TEXT NOT NULL DEFAULT 'EVERY_30_DAYS',
  monthly_amount    REAL NOT NULL DEFAULT 0,
  is_test           INTEGER NOT NULL DEFAULT 0,
  accepted_at       TEXT,
  activated_at      TEXT,
  conversion_at     TEXT,
  churn_at          TEXT,
  churn_reason      TEXT,
  frozen_at         TEXT,
  unfrozen_at       TEXT,
  trial_started_at  TEXT,
  trial_ends_at     TEXT,
  trial_status      TEXT NOT NULL DEFAULT 'none',
  is_plan_change    INTEGER NOT NULL DEFAULT 0,
  paid_sale_count   INTEGER NOT NULL DEFAULT 0,
  first_sale_at     TEXT,
  last_sale_at      TEXT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_subs_app ON subscriptions (app_id, is_test);
CREATE INDEX IF NOT EXISTS idx_subs_ref ON subscriptions (charge_ref);
CREATE INDEX IF NOT EXISTS idx_subs_conversion ON subscriptions (conversion_at);
CREATE INDEX IF NOT EXISTS idx_subs_churn ON subscriptions (churn_at);
CREATE INDEX IF NOT EXISTS idx_subs_shop ON subscriptions (app_id, shop_id);
CREATE INDEX IF NOT EXISTS idx_subs_trial ON subscriptions (trial_status, trial_started_at);

-- Install lifecycle collapsed into half-open intervals [started_at, ended_at).
-- An install is live as-of D iff some interval covers D, which keeps the
-- active-installs query a plain range predicate instead of a per-shop scan.
--
-- \`started_by\` names the event that opened the interval, because two different
-- things open one and only one of them is an acquisition. A merchant choosing
-- the app arrives as RELATIONSHIP_INSTALLED, first time or fifth; a shop that
-- was closed and has reopened arrives as RELATIONSHIP_REACTIVATED, having taken
-- no action at all. Both mean the app is live — which is what the install and
-- churn metrics ask — but only the first belongs at the bottom of a funnel that
-- starts with someone reading the listing.
CREATE TABLE IF NOT EXISTS install_intervals (
  app_id     TEXT NOT NULL,
  shop_id    TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  started_by TEXT NOT NULL DEFAULT 'installed',
  PRIMARY KEY (app_id, shop_id, started_at)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_installs_span ON install_intervals (started_at, ended_at);

-- Clean customer lifecycle events, compiled from the raw feeds by the state
-- machine in sync/events.ts. The raw layer above stays verbatim; this is the
-- derived layer analytics and the Customers page read.
--
-- \`event_id\` is deterministic — the same raw fact always compiles to the same
-- id — so a full rebuild converges instead of accumulating duplicates.
--
-- \`suppressed\` is the cancel trap's soft delete: a cancellation that turned out
-- to be half of a plan change stays on the record but is filtered out of every
-- default read, so churn is never double-counted and the audit trail survives.
CREATE TABLE IF NOT EXISTS customer_events (
  event_id         TEXT PRIMARY KEY,
  app_id           TEXT NOT NULL,
  shop_id          TEXT NOT NULL,
  type             TEXT NOT NULL,
  occurred_at      TEXT NOT NULL,
  charge_id        TEXT NOT NULL DEFAULT '',
  -- The subscription this install was on before this event, when it moved
  -- between subscriptions. Correlates the two halves of a plan change.
  prev_charge_id   TEXT NOT NULL DEFAULT '',
  plan_name        TEXT,
  -- The normalized monthly price in effect after this event.
  plan_amount      REAL,
  billing_interval TEXT,
  currency         TEXT,
  -- Signed monthly MRR delta, gated on the same instant MRR is gated on (the
  -- first paid charge). NULL on events that do not move money.
  net_change       REAL,
  -- Cash actually moved, for payments and refunds. NULL elsewhere.
  amount           REAL,
  suppressed       INTEGER NOT NULL DEFAULT 0,
  detail           TEXT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_cevents_shop ON customer_events (shop_id, occurred_at);
-- \`suppressed\` is the last column and not decoration: the customer list asks
-- for the first and last event of every merchant at once, filtered on it, and
-- without it in the index each candidate row had to be fetched from a WITHOUT
-- ROWID table to be filtered — millions of random seeks for an aggregate that
-- reads nothing else. 2.9s -> 1.1s over 4.2M events, measured. It is a strict
-- extension of the (app_id, shop_id, occurred_at) index it replaces, which the
-- migration step drops.
CREATE INDEX IF NOT EXISTS idx_cevents_app_shop_seen
  ON customer_events (app_id, shop_id, occurred_at, suppressed);
CREATE INDEX IF NOT EXISTS idx_cevents_type_time ON customer_events (type, occurred_at, suppressed);
CREATE INDEX IF NOT EXISTS idx_cevents_charge ON customer_events (charge_id);

-- Where notifications are sent. One row per Slack incoming webhook.
--
-- The URL is the credential: anyone holding it can post into the channel, so it
-- is write-only over the API — the dashboard sends one and never reads one back.
CREATE TABLE IF NOT EXISTS notification_channels (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  webhook_url      TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  last_delivery_at TEXT,
  last_error       TEXT,
  last_error_at    TEXT
) WITHOUT ROWID;

-- Which topics a channel wants. Presence of the row is the "on" state, so
-- turning a toggle off leaves nothing behind to go stale.
--
-- \`enabled_at\` is also the watermark. Events are compiled from the whole
-- Partner API history, so without one, switching a toggle on would replay years
-- of subscriptions into a Slack channel. Only what happens *after* you asked is
-- news, and re-enabling deliberately restarts the clock rather than filling in
-- the silence.
CREATE TABLE IF NOT EXISTS notification_subscriptions (
  channel_id TEXT NOT NULL REFERENCES notification_channels (id) ON DELETE CASCADE,
  topic      TEXT NOT NULL,
  enabled_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, topic)
) WITHOUT ROWID;

-- The delivery ledger, and the reason a merchant is never told twice.
--
-- \`customer_events\` is rebuilt wholesale on every sync, so "new since last
-- time" cannot be read from that table — every row is new every time. What
-- survives a rebuild is the event id, which is deterministic, so recording the
-- ids already sent is what makes an at-most-once guarantee out of a table that
-- is dropped and rewritten every five minutes.
--
-- A row is written for a permanent failure too (\`ok = 0\`): a webhook Slack has
-- revoked will never accept this event, and retrying it every sync forever would
-- bury the events that can still be delivered. Transient failures write nothing
-- and are retried on the next run.
CREATE TABLE IF NOT EXISTS notification_deliveries (
  channel_id   TEXT NOT NULL REFERENCES notification_channels (id) ON DELETE CASCADE,
  event_id     TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  ok           INTEGER NOT NULL DEFAULT 1,
  error        TEXT,
  PRIMARY KEY (channel_id, event_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_deliveries_at ON notification_deliveries (delivered_at);

-- Which App Store listing belongs to which app.
--
-- An organization has many apps and the Partner API will not say which listing
-- any of them is published under — an app knows its id, name and api key, and
-- nothing about the page merchants actually see. Only the partner can supply
-- that link, so it is data they enter rather than configuration in the code.
--
-- Durable for the same reason the notification channels are: nothing here can
-- be recovered by re-syncing. It is deliberately keyed on the app rather than
-- on the handle so that everything the listing page can tell us — reviews now,
-- and whatever a funnel needs later — has one row to hang off.
--
-- \`url\` keeps what was actually pasted; \`handle\` is the slug parsed out of it
-- and is what the crawler builds requests from. Storing both means a listing
-- whose URL shape changes can be re-parsed without asking the partner again.
CREATE TABLE IF NOT EXISTS app_listings (
  app_id       TEXT PRIMARY KEY,
  handle       TEXT NOT NULL,
  url          TEXT NOT NULL,
  -- 'manual' (entered in the dashboard) or 'config' (seeded from the
  -- APP_STORE_HANDLES env var). A person's entry outranks the environment.
  source       TEXT NOT NULL DEFAULT 'manual',
  -- The listing's own title, read from its JSON-LD the last time it was
  -- checked. Confirmation that the pasted URL is the app the partner meant.
  listing_name TEXT,
  checked_at   TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_handle ON app_listings (handle);

-- App Store reviews, scraped from the public listing page.
--
-- This table is role 4, not role 1, and the distinction is the whole feature.
-- Every other raw table can be thrown away and re-fetched; a review cannot. Once
-- Shopify or the merchant takes one down it is gone from the listing forever, so
-- the only copy that will ever exist again is this one. Nothing here is ever
-- deleted — removal is recorded, not applied.
--
-- \`review_id\` is Shopify's own id from the listing markup, which is what makes
-- re-crawling idempotent, removal detectable, and the notification ledger able
-- to promise a review is announced exactly once.
--
-- \`removed_at\` is set when a full sweep completes without seeing the review
-- again. It deliberately does not say *who* removed it: a Shopify purge, a
-- merchant deleting their own review, and a closed store are indistinguishable
-- from outside, and a column implying otherwise would be inventing a fact.
--
-- \`content_hash\` covers the fields a merchant can edit (rating and body). A
-- change means the review was rewritten rather than replaced, which is a
-- different piece of news from a new review arriving.
--
-- \`shop_id\` is the link to the Customers page, and it is a guess. Reviews carry
-- the merchant's *store name* and never the myshopify domain, so the match runs
-- against \`shops.name\` and is only trusted when exactly one shop that actually
-- installed the app answers to that name. \`match_method\` records how the link
-- was arrived at; 'manual' is a human's decision and the matcher never overrides
-- one.
CREATE TABLE IF NOT EXISTS app_reviews (
  review_id       TEXT PRIMARY KEY,
  app_id          TEXT NOT NULL,
  rating          INTEGER NOT NULL,
  posted_on       TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  store_name      TEXT NOT NULL DEFAULT '',
  country         TEXT,
  usage_duration  TEXT,
  reply_body      TEXT,
  reply_on        TEXT,
  permalink       TEXT,
  shop_id         TEXT NOT NULL DEFAULT '',
  -- 'auto' | 'manual' | 'ambiguous' | 'none'
  match_method    TEXT NOT NULL DEFAULT 'none',
  content_hash    TEXT NOT NULL DEFAULT '',
  -- When we last saw the text or rating change, and what the rating was before.
  -- A 5-star rewritten as a 1-star is the single most actionable thing that can
  -- happen to a review, and it never reaches the newest page — the review keeps
  -- its original post date and stays exactly where it was.
  edited_at       TEXT,
  prior_rating    INTEGER,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  removed_at      TEXT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_reviews_app_posted ON app_reviews (app_id, posted_on);
CREATE INDEX IF NOT EXISTS idx_reviews_shop ON app_reviews (shop_id, posted_on);
CREATE INDEX IF NOT EXISTS idx_reviews_removed ON app_reviews (removed_at);
CREATE INDEX IF NOT EXISTS idx_reviews_match ON app_reviews (match_method);

-- The listing's own aggregate, copied verbatim at each crawl.
--
-- We can compute an average from the rows above, but Shopify's published figure
-- is the one merchants see, and the two can legitimately disagree — its rounding
-- and its eligibility rules are not ours. Recording theirs alongside ours turns
-- that disagreement into something visible instead of a silent drift, and
-- \`rating_count\` is also the cheap signal that a sweep is due.
CREATE TABLE IF NOT EXISTS app_review_snapshots (
  app_id       TEXT NOT NULL,
  captured_at  TEXT NOT NULL,
  rating_value REAL,
  rating_count INTEGER,
  PRIMARY KEY (app_id, captured_at)
) WITHOUT ROWID;

-- The BigQuery *account*: the credential and the project, and nothing about
-- where any one app's data lives.
--
-- That division is the whole shape of this feature. A service account and a
-- Google Cloud project are things a partner has one of; a GA4 export dataset is
-- per *property*, and a partner running one GA4 property per listing has as
-- many datasets as they have apps. Putting the dataset here would have made the
-- common case the awkward one.
--
-- Role 4, durable: a service-account key cannot be recovered by re-syncing, and
-- the whole pre-install half of the funnel is unreadable without it.
--
-- \`credentials\` is the credential and is treated like the Slack webhook above —
-- write-only over the API. It is posted once and never sent back; the dashboard
-- identifies the key by \`client_email\` and \`private_key_id\`, which are copied
-- out of the JSON at save time precisely so the key itself never has to be read
-- again to describe it.
--
-- Storing a private key in this file is a real cost, and the settings page says
-- so plainly. It buys a connection that can be rotated from the dashboard on an
-- instance nobody can redeploy.
CREATE TABLE IF NOT EXISTS bigquery_connection (
  id            TEXT PRIMARY KEY CHECK (id = 'default'),
  project_id    TEXT NOT NULL,
  -- Default BigQuery processing location ('US', 'EU', 'asia-south1'…), which an
  -- app may override. A dataset in the EU multi-region answers "not found" to a
  -- job submitted against US, so this has to travel with the dataset.
  location      TEXT NOT NULL DEFAULT 'US',
  credentials   TEXT NOT NULL,
  client_email  TEXT NOT NULL DEFAULT '',
  private_key_id TEXT NOT NULL DEFAULT '',
  -- The GA4 event names are NOT here. There is one publisher of these events
  -- and one spelling that works, so they are constants in the ingest rather
  -- than a setting that could only ever be set wrong.
  checked_at    TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) WITHOUT ROWID;

-- Where one app's listing traffic lives, and how to recognise it inside there.
--
-- \`dataset\` is the required part and has no fallback: an app without one is
-- simply not synced, and the settings page says so rather than quietly reading
-- some other app's property.
--
-- \`location\` is null unless this app's dataset sits somewhere other than the
-- connection's default.
--
-- \`handle\` and \`api_key\` are the two things a GA4 event carries that name an
-- app — Shopify puts the listing handle in the page and item fields of the
-- client-side events and the app's API key on the server-side install event —
-- so they are what separates two apps sharing one GA4 property. Both default
-- from \`app_listings.handle\` and \`apps.api_key\`; a value here only overrides.
CREATE TABLE IF NOT EXISTS bigquery_app_sources (
  app_id     TEXT PRIMARY KEY,
  dataset    TEXT,
  location   TEXT,
  handle     TEXT,
  api_key    TEXT,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- Listing-page traffic, pulled from the GA4 BigQuery export.
--
-- Role 1 and 2 at once: raw in that each row is one GA4 event, normalized in
-- that the app it belongs to and the instant it happened are resolved at write
-- time, so the funnel query is a date compare and a COUNT(DISTINCT) rather than
-- an UNNEST per read.
--
-- \`event_id\` is deterministic — GA4's own (user_pseudo_id, event_timestamp,
-- event_name) triple — which is what lets each sync re-read a couple of hours
-- behind its watermark without duplicating anything. GA4 backfills its daily
-- tables for hours after the fact, so that overlap is not optional.
--
-- \`anonymous_id\` is GA4's user_pseudo_id, and it is a browser rather than a
-- person: a merchant who views the listing on a laptop and installs on a
-- desktop is two visitors here. That is a ceiling on what the first two funnel
-- steps can mean, not a bug to be fixed downstream.
--
-- \`user_key\` is who the funnel counts, and it is resolved at write time in a
-- fixed order of preference: the shop, if the event carried one, then GA4's own
-- User-ID, then the browser. A merchant is a merchant the moment the event says
-- so; only until then are they a cookie.
CREATE TABLE IF NOT EXISTS listing_events (
  event_id      TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL,
  -- 'listing_view' | 'add_app_click'
  type          TEXT NOT NULL,
  occurred_at   TEXT NOT NULL,
  user_key      TEXT NOT NULL DEFAULT '',
  anonymous_id  TEXT NOT NULL DEFAULT '',
  session_id    TEXT NOT NULL DEFAULT '',
  page_location TEXT,
  page_referrer TEXT,
  source        TEXT,
  medium        TEXT,
  campaign      TEXT
) WITHOUT ROWID;

-- The index on \`user_key\` is created by the migration step rather than here.
-- This block runs before it on every open, and on a database that predates the
-- column an index naming it fails outright — taking the whole process down.

CREATE INDEX IF NOT EXISTS idx_listing_events_step
  ON listing_events (app_id, type, occurred_at);
CREATE INDEX IF NOT EXISTS idx_listing_events_visitor
  ON listing_events (anonymous_id, occurred_at);

-- \`cursor_window\` is the window \`cursor\` was produced under — the
-- \`createdAtMin\`/\`occurredAtMin\` of the query that issued it. A Relay cursor is
-- a position inside one query's result set and means nothing inside another, so
-- a resumed pass compares the two and drops a cursor whose window has moved.
-- Added by the migration too, for databases that predate it.
CREATE TABLE IF NOT EXISTS sync_state (
  key            TEXT PRIMARY KEY,
  cursor         TEXT,
  cursor_window  TEXT,
  synced_through TEXT,
  updated_at     TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS metric_cache (
  key        TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  expires_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_cache_expiry ON metric_cache (expires_at);

-- Point-in-time copies of past time series, so a later run can prove that
-- history did not silently move underneath us.
CREATE TABLE IF NOT EXISTS drift_snapshots (
  metric      TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  bucket_date TEXT NOT NULL,
  value       REAL NOT NULL,
  PRIMARY KEY (metric, captured_at, bucket_date)
) WITHOUT ROWID;

/* ---------------------------------------------------------------------------
 * The affiliate ledger (role 5).
 *
 * Everything above this line is either a copy of something the Partner API will
 * hand back again or a function of such a copy. Nothing below it is. An
 * affiliate is a person we owe money to, an attribution is the claim that they
 * are owed it, and no API anywhere can be asked to re-state either — the
 * originals are being imported out of a platform that shuts down on 2026-08-14.
 *
 * So these tables are written to and never rebuilt, and in particular they are
 * invisible to \`rebuildDerivedTables()\`, which drops and rewrites its own
 * tables on every sync. Commission *amounts* are safe to recompute, because the
 * transactions they are computed from are re-fetchable; the attribution they
 * hang off, and the record that one was paid, are not.
 *
 * Deletion is soft throughout, for the same reason. \`deleted_at\` on an
 * attribution unassigns a merchant without destroying the evidence that they
 * were once assigned, which is what a disputed commission is argued from.
 *
 * The joins outward — \`shop_id\` to \`shops\`, \`app_id\` to \`apps\` — carry no
 * foreign key on purpose. Shopify shop and app ids are globally unique so the
 * join is exact, but an attribution can legitimately arrive before the sync has
 * ever seen the shop: the Mantle import lands its referrals against whatever
 * fraction of the shop table exists that day. A constraint there would turn a
 * known-good referral into an import failure, so the column is left blank and
 * \`myshopify_domain\` is kept beside it as the key a later pass re-resolves from.
 * ------------------------------------------------------------------------- */

-- One row per partner who refers merchants to us.
--
-- \`external_id\` is their id in the system they were imported from, and it is
-- what makes the import idempotent and re-reconcilable against Mantle's export
-- for as long as that export exists. It is blank for anyone who signs up here.
--
-- Email is indexed but deliberately not unique: the Mantle data contains one
-- address held by two affiliates, and refusing the import over it would be this
-- schema inventing a rule the business never had.
CREATE TABLE IF NOT EXISTS affiliates (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  email        TEXT NOT NULL DEFAULT '',
  -- Where they asked to be paid. Payout processing happens outside this system;
  -- this is recorded so the person doing it does not have to go looking.
  paypal_email TEXT,
  -- 'active' | 'disabled'
  status       TEXT NOT NULL DEFAULT 'active',
  -- Set by us, not by them: commissions keep accruing, payment does not happen.
  payout_hold  INTEGER NOT NULL DEFAULT 0,
  -- 'imported' | 'signup'
  source       TEXT NOT NULL DEFAULT 'signup',
  external_id  TEXT NOT NULL DEFAULT '',
  -- What this person agreed to, and when they said so.
  --
  -- Blank and NULL for all the imported affiliates, permanently, and that is the
  -- honest state rather than a gap to backfill: Mantle's \`termsUrl\` was never
  -- configured, so not one of them was ever shown terms and none of them agreed
  -- to anything. Writing a date here for them would manufacture a consent record
  -- out of an import, which is the one thing a consent record must never be.
  --
  -- \`terms_url\` stores the URL that was actually presented rather than a
  -- version number, because the URL is the only thing we can point at afterwards
  -- and say "that is what they saw". If the document behind it changes without
  -- the URL changing, this column records less than it appears to — which is an
  -- argument for versioned URLs, not for a second column that repeats the claim.
  terms_url         TEXT NOT NULL DEFAULT '',
  terms_accepted_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliates_external
  ON affiliates (external_id) WHERE external_id <> '';
CREATE INDEX IF NOT EXISTS idx_affiliates_email ON affiliates (email);

-- The terms one app offers its affiliates. One row per app, in practice.
--
-- \`commission_rate\` is a fraction rather than a percentage — 0.2, not 20 —
-- because multiplying is the only thing anyone ever does with it, and a column
-- that has to be divided by 100 before use eventually is not.
--
-- \`duration_months\` NULL means lifetime. The window it opens is measured from
-- the first commission rather than from the referral; that rule belongs to the
-- engine, but it is stated here because the column is where someone will look.
--
-- \`revenue_components\` is a JSON array ('["subscription"]'), which is the shape
-- the source platform used and the shape the settings screen will edit. Nothing
-- queries inside it.
-- \`listing_url\` is the App Store page this program's referral links point at,
-- and it is here rather than only in \`app_listings\` because a program can need
-- one before its app is resolved locally: the Mantle import lands hundreds of
-- live links on day one, and \`app_id\` is blank until the Partner API sync has met the app.
-- \`app_listings\` still wins when it has an entry — that is the operator's own
-- mapping — and this is what a program falls back to instead of a route
-- hardcoding a slug.
CREATE TABLE IF NOT EXISTS affiliate_programs (
  id                            TEXT PRIMARY KEY,
  -- \`apps.id\`. Blank until the app is known locally, which is possible on an
  -- import that runs before the first sync finishes.
  app_id                        TEXT NOT NULL DEFAULT '',
  name                          TEXT NOT NULL DEFAULT '',
  listing_url                   TEXT NOT NULL DEFAULT '',
  commission_rate               REAL NOT NULL DEFAULT 0,
  revenue_components            TEXT NOT NULL DEFAULT '["subscription"]',
  duration_months               INTEGER,
  unassign_after_uninstall_days INTEGER,
  require_approval              INTEGER NOT NULL DEFAULT 0,
  -- 'active' | 'closed'
  status                        TEXT NOT NULL DEFAULT 'active',
  external_id                   TEXT NOT NULL DEFAULT '',
  created_at                    TEXT NOT NULL,
  updated_at                    TEXT NOT NULL
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_programs_external
  ON affiliate_programs (external_id) WHERE external_id <> '';
CREATE INDEX IF NOT EXISTS idx_aff_programs_app ON affiliate_programs (app_id);

-- An affiliate's enrolment in one program, and the link code that carries it.
--
-- \`handle\` is the \`?mref=\` value. It is unique per program and NOT globally:
-- two affiliates in the imported data hold a membership in both programs under
-- one handle, so a global unique index would reject them. Which program a click
-- belongs to is never ambiguous — it is the listing that was clicked.
--
-- The column collates NOCASE, so the unique index and every lookup agree on
-- case. A handle arrives from a URL somebody may have retyped, and the codes
-- are lowercase eight-character strings that a person will capitalise.
--
-- \`status\` is 'enrolled' | 'pending' | 'rejected'. Pending and rejected rows are
-- kept rather than dropped: pending is the approval queue for a program that
-- requires approval, and rejected is the record of a decision — without it the
-- same applicant reappears as new.
CREATE TABLE IF NOT EXISTS affiliate_memberships (
  id           TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliates (id) ON DELETE CASCADE,
  program_id   TEXT NOT NULL REFERENCES affiliate_programs (id),
  handle       TEXT NOT NULL COLLATE NOCASE,
  status       TEXT NOT NULL DEFAULT 'pending',
  joined_at    TEXT NOT NULL,
  approved_at  TEXT,
  rejected_at  TEXT,
  external_id  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) WITHOUT ROWID;

-- The unique constraint self-signup's handle generator has to satisfy: unique
-- per program, not globally. A second index on \`handle\` alone is created by the
-- migration step, because \`/r/:handle\` and the GA4 parser both look a handle up
-- without knowing its program and this composite one cannot seek for them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_memberships_handle
  ON affiliate_memberships (program_id, handle);
CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_memberships_pair
  ON affiliate_memberships (affiliate_id, program_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_memberships_external
  ON affiliate_memberships (external_id) WHERE external_id <> '';

-- The claim that this affiliate is why this merchant installed this app.
--
-- The durable fact of the whole feature. Commissions are recomputed from it;
-- it is recomputed from nothing.
--
-- \`source\` says how the claim arose and is 'ga4' | 'manual' | 'imported'.
-- The distinction is not decorative: only 'ga4' is automated, 'manual' is an
-- admin assigning a merchant retroactively, and roughly two in five of the
-- imported referrals were manual in the platform they came from. A rebuilt
-- pipeline that reproduces only the automated half is under-attributing, and
-- this column is how that is measured rather than guessed at.
--
-- \`shop_id\` may be blank, and \`myshopify_domain\` is why that is survivable —
-- see the note at the top of this section. \`external_page_view_id\` is the
-- imported platform's own evidence of a GA4 listing view, kept for the
-- reconciliation that compares its attribution decisions against ours.
CREATE TABLE IF NOT EXISTS affiliate_attributions (
  id                   TEXT PRIMARY KEY,
  affiliate_id         TEXT NOT NULL REFERENCES affiliates (id),
  program_id           TEXT NOT NULL REFERENCES affiliate_programs (id),
  shop_id              TEXT NOT NULL DEFAULT '',
  myshopify_domain     TEXT NOT NULL DEFAULT '',
  app_id               TEXT NOT NULL DEFAULT '',
  referred_at          TEXT NOT NULL,
  source               TEXT NOT NULL DEFAULT 'manual',
  -- The membership handle credited, when one was. Audit, not a join key: a
  -- handle can be reissued, and this records what was actually followed.
  handle               TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  external_id          TEXT NOT NULL DEFAULT '',
  external_page_view_id TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL,
  deleted_at           TEXT
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_attr_external
  ON affiliate_attributions (external_id) WHERE external_id <> '';

-- One live claim per merchant per program. Enforced on the domain rather than
-- on \`shop_id\` because the domain is the column that is always populated, and
-- the two are one-to-one. Soft-deleted rows are excluded, which is what lets a
-- merchant be reassigned without first destroying the previous claim.
CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_attr_live
  ON affiliate_attributions (program_id, myshopify_domain)
  WHERE deleted_at IS NULL AND myshopify_domain <> '';

CREATE INDEX IF NOT EXISTS idx_aff_attr_affiliate
  ON affiliate_attributions (affiliate_id, referred_at);
CREATE INDEX IF NOT EXISTS idx_aff_attr_shop ON affiliate_attributions (shop_id);
-- The work list for re-resolving referrals whose shop had not synced yet.
CREATE INDEX IF NOT EXISTS idx_aff_attr_unresolved
  ON affiliate_attributions (myshopify_domain) WHERE shop_id = '';

-- What one transaction earned one affiliate.
--
-- Half recomputable, half not, and the split is the reason for the column list.
-- \`amount\` is a pure function of the transaction and the program's rules, so
-- the engine may rewrite it whenever either changes. The payment columns are
-- not a function of anything: they record that money left the building, which
-- happens outside this system entirely and can never be re-derived from it.
-- Recomputation therefore updates in place, keyed on (attribution, transaction),
-- and never deletes a row that carries \`paid_at\`.
--
-- \`transaction_id\` is \`transactions.id\` and is blank on imported rows, because
-- the source platform identified transactions by its own ids and none of them
-- are ours. \`external_transaction_id\` keeps its id, and \`earned_at\` plus
-- \`basis_amount\` keep enough of the transaction to match it back to a Partner
-- API row later — which is exactly the diff that proves the engine correct.
CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id                      TEXT PRIMARY KEY,
  attribution_id          TEXT NOT NULL REFERENCES affiliate_attributions (id),
  -- Denormalized from the attribution: who is owed this. An attribution can be
  -- reassigned, and a commission already earned does not move with it.
  affiliate_id            TEXT NOT NULL,
  program_id              TEXT NOT NULL,
  transaction_id          TEXT NOT NULL DEFAULT '',
  amount                  REAL NOT NULL DEFAULT 0,
  currency                TEXT NOT NULL DEFAULT 'USD',
  -- The gross the rate was applied to, and the rate applied, as of computation.
  -- Stored rather than looked up so a statement issued last year still explains
  -- itself after the program's terms change.
  basis_amount            REAL,
  rate                    REAL,
  -- When the underlying transaction happened, which is what a duration window
  -- and a statement period are measured on. \`computed_at\` is when we last did
  -- the arithmetic, and the two are years apart on the imported rows.
  earned_at               TEXT NOT NULL,
  computed_at             TEXT NOT NULL,
  -- 'computed' | 'imported'
  source                  TEXT NOT NULL DEFAULT 'computed',
  external_id             TEXT NOT NULL DEFAULT '',
  external_transaction_id TEXT NOT NULL DEFAULT '',
  -- Paid elsewhere, recorded here. \`payment_reference\` is whatever the payer's
  -- system calls the payment — a payout id on import, a PayPal batch id after.
  paid_at                 TEXT,
  paid_amount             REAL,
  payment_reference       TEXT,
  -- The payout that settled this commission, once one exists locally.
  --
  -- Resolved from \`payment_reference\` rather than replacing it: the reference
  -- is what the payer's system said, which is a fact, and this is our own row id
  -- for the same payment, which is a join. Keeping both means a payout that was
  -- never imported still leaves the evidence of the payment behind.
  --
  -- Blank is a real state and not an error. Most of the imported
  -- commissions were never part of any payout — they are simply unpaid — and a
  -- commission paid by some later PayPal batch will carry a reference that names
  -- no payout at all.
  payout_id               TEXT NOT NULL DEFAULT '',
  payment_note            TEXT,
  -- A commission withdrawn after the fact (a refunded charge, a fraudulent
  -- referral). Soft, so the affiliate's statement can still explain the change.
  cancelled_at            TEXT,
  cancel_reason           TEXT
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_comm_external
  ON affiliate_commissions (external_id) WHERE external_id <> '';
-- One commission per transaction per attribution. Partial, because imported
-- rows carry no local transaction id and would otherwise all collide on ''.
CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_comm_txn
  ON affiliate_commissions (attribution_id, transaction_id)
  WHERE transaction_id <> '';
CREATE INDEX IF NOT EXISTS idx_aff_comm_affiliate
  ON affiliate_commissions (affiliate_id, earned_at);
CREATE INDEX IF NOT EXISTS idx_aff_comm_attribution
  ON affiliate_commissions (attribution_id);
CREATE INDEX IF NOT EXISTS idx_aff_comm_unpaid
  ON affiliate_commissions (affiliate_id) WHERE paid_at IS NULL AND cancelled_at IS NULL;
-- The index on \`payout_id\` is created by the migration step rather than here,
-- for the same reason as \`idx_listing_events_visitor\` above. This block runs
-- before the migration on every open, and on a database whose
-- \`affiliate_commissions\` predates the column an index naming it fails
-- outright — taking the whole process down, including the routes that never
-- touch a payout.

-- One payment to one affiliate, for a period of their commissions.
--
-- A record of something that happened elsewhere, and nothing more. This system
-- does not pay anybody: it has no rails, no schedule, no threshold and no status
-- machine, and none of those belong here later either. What it has is a small
-- number of rows of Mantle's history, which would otherwise have survived only as
-- three columns on the commissions they settled — enough to answer "was this
-- paid" and not enough to answer "what was in that payment", which is the
-- question an affiliate asks when a number on their statement is unfamiliar.
--
-- Role 5 and durable for the same reason as everything else in this cluster: no
-- API will restate that money left the building. Deletion is soft.
--
-- \`status\` carries Mantle's word for it, and there are exactly two in the data:
-- 'paid' (nearly all of them) and 'requested' (a single row, which Mantle shut
-- down before settling). It is descriptive, not a workflow — nothing here transitions
-- a payout, because nothing here pays one.
--
-- \`amount\` is what the payout was raised for and \`amount_paid\` is what the
-- payer recorded actually sending, NULL while unpaid. They are separate columns
-- rather than one because a payment that went out short is a discrepancy someone
-- has to see, and a single column would hide it by construction.
--
-- \`number\` is Mantle's human-facing reference (a contiguous range here) and is
-- what an affiliate quotes in an email. It is stored as text and never re-used as a key:
-- it is an outside system's counter, and ours starts wherever it starts.
--
-- \`period_start\`/\`period_end\` are the window the payout claimed to cover. They
-- are Mantle's own bounds and are not always the extent of the commissions
-- actually attached — the link is \`affiliate_commissions.payout_id\`, and that,
-- not this window, is what the payout paid for.
-- \`program_id\` is nullable, unlike everywhere else in this cluster, because a
-- handful of Mantle's payouts carry no program at all — they are the earliest
-- ones, the lowest reference numbers, raised before payouts were scoped to a
-- program. The import fills those in from the commissions they paid for, but
-- only where every
-- one of those commissions agrees on a single program, which is the difference
-- between reading the answer off the ledger and guessing it. NULL is what a
-- payout gets when they do not agree, and it means "not recorded", not "none".
CREATE TABLE IF NOT EXISTS affiliate_payouts (
  id             TEXT PRIMARY KEY,
  affiliate_id   TEXT NOT NULL REFERENCES affiliates (id),
  program_id     TEXT REFERENCES affiliate_programs (id),
  number         TEXT NOT NULL DEFAULT '',
  -- 'paid' | 'requested'
  status         TEXT NOT NULL DEFAULT 'requested',
  amount         REAL NOT NULL DEFAULT 0,
  amount_paid    REAL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  period_start   TEXT,
  period_end     TEXT,
  paid_at        TEXT,
  -- 'paypal', 'stripe', … as the payer's system named it. Free text on purpose:
  -- constraining it would be this schema having an opinion about rails it does
  -- not operate.
  payment_method TEXT,
  notes          TEXT,
  external_id    TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_payouts_external
  ON affiliate_payouts (external_id) WHERE external_id <> '';
CREATE INDEX IF NOT EXISTS idx_aff_payouts_affiliate
  ON affiliate_payouts (affiliate_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_aff_payouts_program ON affiliate_payouts (program_id);

-- How an affiliate proves they are themselves, and nothing else.
--
-- Separate from \`affiliates\` on purpose. That table is a ledger record imported
-- from elsewhere and rewritten by every re-import; this one is a credential that
-- an import must never touch, and keeping them apart makes that structural
-- rather than a rule someone has to remember. It also means the row simply does
-- not exist for the affiliates who have never set a password, which is the
-- honest representation of that state — no sentinel hash, nothing to mistake for
-- one.
--
-- \`password_hash\` is scrypt over a per-row 16-byte salt, both hex. Per-row
-- because a shared salt would let one rainbow table cover hundreds of people;
-- scrypt because it is in \`node:crypto\` and this project's dependency list is four
-- entries by choice.
--
-- The reset columns hold a *digest* of the outstanding token, never the token.
-- A database that leaks must not hand over the ability to take over accounts,
-- which is exactly what a stored plaintext token is. \`reset_expires_at\` bounds
-- it in time and clearing \`reset_token_hash\` on redemption bounds it to one
-- use; both are checked, because either alone leaves a hole.
CREATE TABLE IF NOT EXISTS affiliate_credentials (
  affiliate_id       TEXT PRIMARY KEY REFERENCES affiliates (id) ON DELETE CASCADE,
  -- Blank until the affiliate completes a set-password flow. A blank hash never
  -- verifies: see \`verifyPassword\` — it is not a password anyone can present.
  password_hash      TEXT NOT NULL DEFAULT '',
  password_salt      TEXT NOT NULL DEFAULT '',
  password_set_at    TEXT,
  reset_token_hash   TEXT NOT NULL DEFAULT '',
  reset_expires_at   TEXT,
  -- When the current outstanding token was issued, so a flood of requests for
  -- one address is visible without keeping a separate log.
  reset_requested_at TEXT,
  last_login_at      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
) WITHOUT ROWID;

-- Which affiliate has been sent which transactional email, and when.
--
-- The same shape and the same job as \`notification_deliveries\`: a durable
-- record of the *fact* of a delivery, so that a run which stops halfway can be
-- resumed without asking the same person twice. Onboarding hundreds of partners
-- is one bulk send that takes a quarter of an hour, and a failure part way
-- through must cost only the remainder, not the whole run — the ledger is what
-- makes the difference.
--
-- What is recorded is the fact, the address it went to, and the outcome.
-- **Never the token, never the link.** The link is a 24-hour account-takeover
-- credential; a table that stored one would be a strictly worse version of the
-- log line the security review removed, because a table persists.
--
-- Keyed on (affiliate, kind) rather than appended to, so "has this person been
-- sent their invite" is a primary-key lookup rather than a scan with a MAX over
-- it. \`attempts\` carries what an append-only log would have carried that is
-- actually worth keeping: how many times we have tried. A failed row is left in
-- place with \`ok = 0\` and is retried by the next run; only \`ok = 1\` stops a
-- resend, because an email that never left is not a delivery.
CREATE TABLE IF NOT EXISTS affiliate_email_deliveries (
  affiliate_id TEXT NOT NULL REFERENCES affiliates (id) ON DELETE CASCADE,
  -- 'set_password' today. A column rather than a table per message type,
  -- because the next one will want exactly these five fields.
  kind         TEXT NOT NULL,
  -- The address as it was at send time. An affiliate who changes their email
  -- later leaves this alone: it answers "where did it go", not "where do they
  -- live now".
  email        TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  -- NULL until one attempt has actually been accepted by the relay.
  delivered_at TEXT,
  attempts     INTEGER NOT NULL DEFAULT 1,
  ok           INTEGER NOT NULL DEFAULT 0,
  -- The relay's own refusal text, trimmed. Ours never contains a link.
  error        TEXT,
  PRIMARY KEY (affiliate_id, kind)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_affiliate_email_deliveries_at
  ON affiliate_email_deliveries (kind, attempted_at);
/* --- affiliate attribution claims (role 5) -------------------------------- */

-- An affiliate asserting "this merchant was mine", waiting for a decision.
--
-- A request, not a fact, and the distinction is the whole table. Everything else
-- in this cluster records something that happened; this records something
-- somebody says happened and that nobody has ruled on yet. It therefore earns no
-- commission, appears in no balance, and is joined to by nothing in the
-- engine — a claim only ever becomes money by an operator approving it, which
-- writes an ordinary \`source='manual'\` row in \`affiliate_attributions\` through
-- the same path a hand assignment uses.
--
-- Hundreds of these were carried out of Mantle, and a pending queue of them is
-- still undecided.
-- They are imported *as pending*: the operator has deliberately not decided
-- them, and an import that inferred a decision would be making that call on
-- their behalf and silently moving money to do it.
--
-- \`status\` is stored, and in Mantle it was not — there it was derived from two
-- nullable timestamps, \`rejectedAt\` winning over \`approvedAt\`. Deriving it at
-- read time here would spread that precedence rule across every query that
-- filters on it, so it is resolved once on the way in and the timestamps are
-- kept beside it as the evidence.
--
-- \`shop_id\` may be blank, for exactly the reason it may be blank on an
-- attribution: the claim names a merchant by \`myshopify_domain\` and the Partner
-- API sync may not have reached them yet. \`resolveClaimShops()\` fills it in
-- later, and nothing here waits on it.
--
-- \`attribution_id\` is the referral this claim corresponds to, where one exists.
-- It is a link and never a creation: the imported ledger already holds a large
-- minority of manual attributions that these approvals almost certainly
-- produced, and pointing at them is what stops a re-import writing the same
-- referral twice.
-- Blank is a real and expected answer — an approval whose attribution was later
-- unassigned, or never made, has nothing to point at, and inventing one would be
-- this import deciding that a merchant belongs to somebody.
--
-- \`decided_by\` is free text and is the *name Mantle recorded*, not a local user:
-- this dashboard authenticates with one shared password and has no user table,
-- so there is no identity to resolve it against. A decision made here carries
-- whatever the operator chose to sign it with, or nothing.
CREATE TABLE IF NOT EXISTS affiliate_attribution_claims (
  id                   TEXT PRIMARY KEY,
  affiliate_id         TEXT NOT NULL REFERENCES affiliates (id),
  program_id           TEXT NOT NULL REFERENCES affiliate_programs (id),
  -- Blank until the merchant has synced; the domain is the durable identity.
  shop_id              TEXT NOT NULL DEFAULT '',
  myshopify_domain     TEXT NOT NULL DEFAULT '',
  -- The merchant as the claimant named them. Kept because it is what the
  -- affiliate typed, which is not always what the installation is called.
  customer_name        TEXT NOT NULL DEFAULT '',
  -- When the affiliate says the referral happened, which is not when they asked.
  claimed_at           TEXT NOT NULL,
  notes                TEXT,
  -- 'pending' | 'approved' | 'rejected'
  status               TEXT NOT NULL DEFAULT 'pending',
  decided_at           TEXT,
  decided_by           TEXT NOT NULL DEFAULT '',
  decision_notes       TEXT,
  approved_at          TEXT,
  rejected_at          TEXT,
  -- The referral this claim corresponds to. Blank when none does.
  attribution_id       TEXT REFERENCES affiliate_attributions (id),
  external_id          TEXT NOT NULL DEFAULT '',
  -- Mantle's installation id, kept so a claim can be re-joined to its export.
  external_installation_id TEXT NOT NULL DEFAULT '',
  -- Mantle's user id for the decision maker. Meaningless here on its own, which
  -- is why the human-readable name is stored beside it rather than instead.
  decided_by_external_id   TEXT NOT NULL DEFAULT '',
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  deleted_at           TEXT
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_aff_claims_external
  ON affiliate_attribution_claims (external_id) WHERE external_id <> '';
-- The queue, in the order it is worked: oldest claim first, within a status.
CREATE INDEX IF NOT EXISTS idx_aff_claims_status
  ON affiliate_attribution_claims (status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_aff_claims_affiliate
  ON affiliate_attribution_claims (affiliate_id, claimed_at);
CREATE INDEX IF NOT EXISTS idx_aff_claims_program
  ON affiliate_attribution_claims (program_id, status);
CREATE INDEX IF NOT EXISTS idx_aff_claims_attribution
  ON affiliate_attribution_claims (attribution_id);
-- The work list for re-resolving claims whose merchant had not synced yet, the
-- same shape as \`idx_aff_attr_unresolved\` and drained by the same sync pass.
CREATE INDEX IF NOT EXISTS idx_aff_claims_unresolved
  ON affiliate_attribution_claims (myshopify_domain) WHERE shop_id = '';
`;
