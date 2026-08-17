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
 *
 * Roles 1 and 2 are disposable: both are rebuilt from the API on demand. Role 4
 * is the only place in this store holding state that cannot be recovered by
 * re-syncing, which is why its tables are written to rather than rebuilt.
 *
 * Every timestamp column holds a canonical UTC ISO-8601 string, so lexical
 * comparison is chronological comparison and the as-of predicate is plain SQL.
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS apps (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  api_key        TEXT,
  discovered_at  TEXT NOT NULL
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
`;
