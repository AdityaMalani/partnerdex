# PartnerDex

Self-hosted analytics for your Shopify apps. Pulls your Partner API history into a local SQLite store and reconstructs **MRR, ARR, gross earnings, ARPU, LTV, trials, churn, and active subscribers as of any past date**.

Nothing leaves your machine, and no app IDs, app names, or organization IDs live in the code — everything is configuration.

<!-- Add a screenshot here once you have one you're happy with. -->

---

## 1. Introduction

PartnerDex provides a privacy-first, fully customizable, self-hosted analytics dashboard designed specifically for Shopify app developers. Instead of relying on external services or static pre-computed snapshots, PartnerDex builds its entire reporting suite directly from raw event history. Every historical point in every timeseries is reconstructed dynamically by determining subscription statuses at that specific instant.

### Key Features
- **Deterministic Historical Metrics:** MRR, ARR, and subscriber counts as of any past date remain perfectly consistent. Late-arriving cancellations or retroactively issued refunds automatically correct historical calculations on the subsequent sync.
- **Self-Hosted & Private:** All fetched data is stored in a local SQLite database on your own infrastructure. No third-party servers are involved.
- **Comprehensive Lifecycle Insights:** Reconstructs detailed customer lifecycles, uninstall timelines, trials, churn, App Store reviews, and revenue analytics.
- **Install Funnel:** Listing page view → Add app click → install → trial → conversion, with the count and step-over-step conversion for every period. The two pre-install steps are read from the GA4 BigQuery export; where that is not connected they are reported as unmeasurable rather than as zero.
- **Slack Notifications:** Real-time, deduplicated alerts for subscription events (starts, upgrades, churn) and App Store review changes.
- **CLI & HTTP API:** Query metrics directly from the command line, export custom intervals, or connect your own reporting tools.

---

## 2. Get started locally

### Prerequisites
- Node.js 20+
- A Shopify Partner API client with **View financials** and **Manage apps** permissions (located in the Shopify Partners Dashboard → Settings → Partner API clients).

### Setup and Installation

1. **Clone the repository and install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   Fill in the following variables in `.env`:
   - `PARTNER_API_TOKEN`: The access token of your Partner API client.
   - `PARTNER_ORGANIZATION_ID`: Your Shopify Partners Dashboard Organization ID (found in the URL: `partners.shopify.com/<id>/...`).
   - `PARTNER_API_VERSION`: A supported Shopify API version (e.g., `2026-07`).
   - `DASHBOARD_PASSWORD`: Set a password (at least 8 characters) to secure the dashboard. If left empty, no login is required (localhost default).

3. **Verify API connectivity and pull your history:**
   - Run the diagnostic utility to verify setup:
     ```bash
     npm run doctor
     ```
   - Sync your historical data:
     ```bash
     npm run sync
     ```
     *Note: The first sync backfills historical data starting from `SYNC_START_DATE` and may take a few minutes. Subsequent syncs are incremental and fast.*

4. **Build and start the application:**
   ```bash
   npm run build
   npm start
   ```
   Open your browser and navigate to `http://localhost:8787`.

### Local Development
To run the server with hot-reloading for both the API and the frontend dashboard (using Vite):
```bash
npm run dev
```

### Running Tests
To run the automated test suite:
```bash
npm test
```

---

## 3. Deploy on production

PartnerDex is designed to run as a single-node process on a single machine with a persistent volume for the SQLite database.

For quick and easy production deployment using Fly.io, refer to the detailed guide in [DEPLOY.md](DEPLOY.md).

---

## 4. Details and customizations

### Sync Cadence
When running `npm start`, the background loop syncs the SQLite database every 5 minutes by default.
- You can change this interval by setting `SYNC_INTERVAL_MINUTES` in your `.env`. Set it to `0` to disable background syncing and run syncs manually.
- Failed syncs implement a geometric backoff up to a maximum of 30 minutes, with the status reported in the dashboard footer.
- Sync operations are designed with file locking to ensure runs never overlap.

### Scope and Filtering (Choosing Apps)
To configure which Shopify apps are included in the reports, set the `PARTNER_APP_IDS` variable in `.env`:
- **When set:** Includes only the comma-separated list of specified Shopify App IDs. Useful for separating production apps from development or test instances.
- **When empty:** Automatically resolves to every app that has ever appeared on a transaction.
- *Note: Test charges and test shops are automatically excluded from metrics.*

### Dashboard Security and Lockout
If `DASHBOARD_PASSWORD` is configured (minimum 8 characters), the application secures the web UI and JSON endpoints behind a cookie-based login.
- **Session Lifetimes:** Selecting "Remember me" creates a persistent cookie lasting 30 days. Otherwise, the session expires in 12 hours or when the browser closes.
- **Throttling:** Brute-force protection locks out client IPs for 1 minute after 5 failed login attempts, with increasing delays for subsequent attempts.
- **SSL/TLS:** The auth mechanism relies on plain HTTP cookies for simplicity. Always terminate TLS/SSL in front of PartnerDex when deploying to an untrusted network.

### Metric Definitions

| Metric | Definition |
|---|---|
| **MRR** | Normalized monthly amounts of live paid subscriptions. Annual plans contribute 1/12 of their price; 30-day plans contribute their full price. Active trials contribute zero until the first paid charge settles. Frozen subscriptions contribute zero. |
| **ARR** | MRR × 12. Represents an instantaneous run rate. |
| **Gross earnings** | Actual cash collected inside the period, less refunds and credits. Includes subscription, one-time, and usage charges. Before Shopify's revenue share. |
| **ARPU** | MRR divided by active paying population. `METRICS_BY_SHOP` determines whether population is counted by subscribers or individual subscriptions. |
| **LTV** | ARPU divided by the monthly subscription churn rate. Represents an instantaneous, forward-looking cohort value. |
| **MRR growth** | Percentage change in MRR compared to the start of the period. |
| **MRR contribution by app** | MRR as of the end of the range, split by the app earning it, with each app's share of the total. Every app gets its own row, ordered largest first — the parts sum to the MRR headline by construction. |
| **MRR movement** | Where MRR moved inside each bucket, summed from the signed `net_change` on the event ledger: **New** (first subscriptions, win-backs and trial conversions), **Frozen**, **Unfrozen**, **Churned**, **Upgraded**, **Downgraded**, and the **Net** of them. Losses are negative, so each row adds across to Net. The six categories are exhaustive over the events that carry a delta. Because the ledger books money at the first paid charge, the trials toggle does not apply to it, and the net may differ slightly from the change in the reconstructed MRR level — a movement view and a level are two different readings of the same facts. |
| **Trials** | Count of trials started in the period, split into converted and cancelled. |
| **On trial** | Instantaneous count of active trials at that exact point in time. |
| **Trialing** | Current trial subscription value grouped by each expected trial end date. |
| **New subscriptions** | Subscriptions starting their first paid cycle in the period, excluding plan upgrades or downgrades. |
| **Subscription growth** | Percentage change in live paid subscriptions over the period. |
| **Churn** | Rolling 30-day loss rate. The denominator is the live population at the start of the window. |
| **Revenue / subscription churn** | MRR lost versus subscription contracts lost. |
| **Logo churn** | Uninstalls net of reinstalls divided by active installs at the start of the window. Includes free installs. |
| **Subscribers** | Unique shop-and-app pairs with a live paid subscription. |
| **Active subscriptions / installs** | Live counts at that instant. Installs includes all active merchant shops (paying and non-paying). |
| **Funnel — listing page view** | Distinct *people* who fired the listing-view event in the period — never a raw event count. Identity resolves in a fixed order: the shop the event named, else GA4's User-ID, else the browser (`user_pseudo_id`). |
| **Funnel — add app clicked** | Distinct people who fired the Add-app-click event in the period, resolved the same way. |
| **Funnel — installed** | Distinct shops whose install interval began in the period. |
| **Funnel — trial started** | Distinct shops that began a free period. Plan changes carry a nominal trial window they never sat through and are excluded. |
| **Funnel — trial converted** | Of the trials *started* in the period, those that reached a paid charge. Credited to the cohort that produced them, which is why the newest columns are provisional. |

### Under-the-Hood Inferences
1. **Inferred Trials:** Trial periods are detected based on the gap between subscription activation and the first paid charge transaction. `TRIAL_MIN_GAP_DAYS` (default `2`) defines this threshold.
2. **Billing Dates as Fallbacks:** Late-settling payout transactions are accounted for dynamically. Subscriptions with active billing dates that have not received cancellation events are assumed active to prevent artificial drops.
3. **Plan Upgrades/Downgrades:** Shopify models plan changes by cancelling the old subscription and creating a new one. PartnerDex correlates these events within `PLAN_CHANGE_WINDOW_DAYS` to avoid reporting upgrades as churn.

### Customer Lifecycles and Events
The Partner API event stream is compiled into a high-level customer lifecycle state machine in the `customer_events` table:
- **Account:** `installed`, `reinstalled`, `uninstalled`, `deactivated`, `reactivated`
- **Subscription:** `subscribed`, `resubscribed`, `upgraded`, `downgraded`, `unsubscribed`, `subscription_frozen`, `subscription_unfrozen`, `charge_abandoned`
- **Trial:** `trial_started`, `trial_converted`, `trial_expired`
- **Money:** `payment`, `refund`

The delta change in monthly MRR is recorded in the `net_change` field, ensuring that the sum of all historical events perfectly matches the reconstructed state:
$$\sum \text{net\_change} = \text{MRR reconstructed as of now}$$

You can rebuild the derived event tables from scratch at any time:
```bash
npm run rebuild
```

### App Store Reviews Tracking
Since the Partner API does not include review data, PartnerDex crawls the public Shopify App Store listing.
- **Setup:** Map your apps to their listing URLs in the **App listings** settings page in the dashboard.
- **Syncing:** Crawling is sequential, rate-limited, and obeys `robots.txt`. Gaps in reviews (indicating a deleted or removed review) are detected via daily deep sweeps (`REVIEW_SWEEP_HOURS`).
- **Attribution:** Reviews are matched to customer database entries by unique installer store name. Unmatched reviews can be linked manually via the UI.

### Install Funnel and BigQuery
The funnel spans five steps, and it is deliberately fed by two different stores:

| Step | Source | Unit |
| --- | --- | --- |
| 1. Listing page view | GA4 BigQuery export | browser |
| 2. Add app clicked | GA4 BigQuery export | browser |
| 3. Installed | Partner API | shop |
| 4. Trial started | Partner API | shop |
| 5. Trial converted | Partner API | shop |

**Why the split.** Nothing before the install exists in the Partner API. Shopify emits `page_view` when a merchant opens your listing and `Add App button` — spaces and capitals included, a name it kept from Universal Analytics — when they click Install, but only into the Google Analytics property whose measurement id is on the listing. Installs, trials and conversions, on the other hand, are *complete* in the Partner API and are only partially observable in GA4 — so each step is taken from the store that actually knows it.

**Reading the 2 → 3 rate.** It crosses a seam: GA4 counts browsers, the Partner API counts shops. A merchant who browses on a laptop and installs on a desktop is two visitors and one install; one whose browser blocks analytics is no visitor and one install. The rate is therefore directional — useful for "is this improving", not for "what fraction of clickers installed" — and the UI draws the seam rather than hiding it. Where a step exceeds the one above it the report **warns and leaves the counts alone**; capping installs to fit GA4's coverage would delete real installs to make a chart look tidy.

#### Setup, once

Do these in order — each one produces something the next step needs. Steps 1 and 2 are what make the data exist at all; nothing before them can be backfilled, so a listing instrumented today has no history from yesterday.

1. **Put a GA4 measurement id on the listing.** Partner Dashboard → **Apps** → your app → **Distribution** → **Manage listing** → the listing you want → **Tracking information** → *Google analytics code* → paste the measurement id → **Save**.
   You do **not** need the Measurement Protocol API secret that the same page asks for. That one exists for Shopify's server-side `shopify_app_install` event, which PartnerDex deliberately ignores — installs come from the Partner API, where they are complete.
2. **Turn on the BigQuery export.** In that GA4 property: **Admin** → **Product links** → **BigQuery links** → **Link** → choose a Google Cloud project → pick a data location → under *Data streams and events* include the web stream → choose **Daily** frequency → **Submit**.
   Daily is what PartnerDex reads. Streaming is optional and costs extra; leaving it off changes nothing here.
3. **Wait for the first export.** The first `events_YYYYMMDD` table appears roughly 24 hours later. Until it does, step 5's connection test will correctly report that the dataset holds no export tables.
4. **Create a service account and download its key.** Google Cloud console → **IAM & Admin** → **Service Accounts** → **Create service account** → name it (`partnerdex`) → **Done**. Then open it → **Keys** → **Add key** → **Create new key** → **JSON** → **Create**. The file downloads once and cannot be re-downloaded.
   Grant it exactly two roles: **BigQuery Job User** on the project (IAM & Admin → IAM → Grant access), and **BigQuery Data Viewer** on the export dataset (BigQuery → the dataset → **Sharing** → **Permissions** → **Add principal**). Nothing it reads needs write access.
5. **Connect it.** In PartnerDex: **Settings → BigQuery** → fill the fields below → **Save** → **Test connection**.

#### Where to find each value

The settings page is two cards, because the data is at two levels. **A Google Cloud project and a service account are things you have one of. A GA4 export dataset belongs to a GA4 property**, and if you put a separate measurement id on each listing you have one dataset per app — so the dataset sits with the app.

**Card 1 — Google Cloud account.** Shared by every app. The two GA4 event names are not settings: the funnel always reads `page_view` and `Add App button`, which is what Shopify sends. (Note the lowercase *button* — GA4 names are case-sensitive, and `Add App Button` silently matches nothing.)

| Field | Where it comes from | Looks like |
| --- | --- | --- |
| **Google Cloud project ID** | GA4 → **Admin** → **Product links** → **BigQuery links** → click the link → *Project ID*. Or the top-left project picker in the Google Cloud console — use the **ID**, not the display name; they differ. | `my-analytics-project`, `acme-web-402118` |
| **Default location** | BigQuery console → click the dataset → **Details** → *Data location*. This is what you chose in step 2 and cannot be changed afterwards. A job sent to the wrong location reports "dataset not found", not a location error — which is why it is worth getting right here. Apps whose export sits elsewhere override it in card 2. | `US`, `EU`, `asia-south1` |
| **Service-account key** | The JSON file from step 4. Open it in a text editor and paste the whole thing, braces included. Do not retype or reformat it — the `\n` escapes inside `private_key` must survive, and that is the single most common reason a connection fails. | `{"type": "service_account", …}` |

**Card 2 — GA4 export per app.** One row per app in reporting scope.

| Field | Where it comes from | Looks like |
| --- | --- | --- |
| **GA4 export dataset** | BigQuery console → **Explorer** → expand the project → the dataset named `analytics_<property id>`. Or build it yourself: GA4 → **Admin** → **Property settings** → **Property details** → *Property ID*, prefixed with `analytics_`. Use the property whose measurement id is on **this** app's listing. After **Test connection** in card 1, this field autocompletes from the datasets the account can actually see. | `analytics_123456789` |
| **Location** | Leave empty to use the default from card 1. Fill it in only when this app's export sits in a different region: BigQuery → the dataset → **Details** → *Data location*. | `EU` |
| **Listing handle** | The slug in your listing URL: `apps.shopify.com/`**`your-app`**. Prefilled from **Settings → App listings**. Used **only** when two apps here share one dataset, to tell their events apart. With a dataset of its own, an app counts everything in it — and that is deliberate: a listing addresses some of its own pages by numeric id (`apps.shopify.com/reviews/1384570` is its reviews tab), so filtering on the handle would drop real views. | `stock-sync` |

There is **no fallback for the dataset**. An app without one is skipped by the sync and its funnel reports the first two steps as unmeasured — deliberately, because guessing which GA4 property belongs to an app is the one mistake that would quietly fill one listing's funnel with another listing's traffic.

**Match `REPORTING_TIMEZONE` to the GA4 property.** GA4 stamps each row with `event_date` in the *property's* timezone; the funnel buckets by `REPORTING_TIMEZONE`. If they differ, every daily column is a different slice of time from the one Google shows and the two disagree by a few visitors a day for no visible reason. **Test dataset** infers the property's offset from where its days begin and says so when the two disagree.

**Checking it worked.** Both checks read `INFORMATION_SCHEMA` only — they cost nothing and scan no event data.

- **Test connection** (card 1) proves the credential, the project and that the BigQuery API is on, then lists the datasets the account can see. Those become the autocomplete for the dataset fields below.
- **Test dataset** (card 2, per app) proves that dataset really is a GA4 export, and reports how many daily tables it holds and the dates they span.

Then **Sync now**, and the Funnel page's first two steps stop reading `—`.

Traffic is then pulled on the normal sync loop into `listing_events`, incrementally, with a six-hour lookback overlap (GA4 backfills its daily tables for hours after they appear) and a one-year ceiling on the first backfill. Today's traffic arrives a day late: GA4's `events_intraday_*` tables are deliberately not read, because they are rewritten into the daily table afterwards.

**One app at a time.** The App filter on this page lists only apps with a GA4 dataset configured, and has no "all apps" entry. Both restrictions are deliberate: an app without a dataset has no top to its funnel, and summing across apps puts one app's visitors above several apps' installs — which reads as a conversion rate over 100%. (`GET /api/funnel` still accepts several apps for callers that want them, and warns when their instrumentation is uneven.)

**Granularity.** Daily, weekly, monthly, or the previous seven days as a single column. The first three set the column width inside whatever range is selected; the last carries its own range and disables the range control.

The service-account key is stored in the local database and is never sent back to the browser — the dashboard identifies it by the account email and the tail of the key id. Disconnecting deletes the key and keeps the traffic already collected.

### Slack Notifications
Configure an incoming Slack webhook under the **Notifications** tab to receive alerts for subscription and review changes.
- **Subscription events:** Subscriptions started, restarted, upgraded, downgraded, frozen, and cancelled.
- **Review events:** New reviews, updated ratings, and removals.
- **Deduplication:** Alerts are tracked in `notification_deliveries` to ensure no notification is sent twice, even after full database rebuilds.

### Querying from the Command Line
Use the built-in CLI to pull raw metrics:
```bash
# Query MRR for the last 12 months in monthly intervals
npx partnerdex query mrr --period=last_12_months --interval=month

# Query MRR as it stood on a specific historical date
npx partnerdex query mrr --period=last_12_months --asOf=2024-06-30
```

### HTTP JSON API
The server exposes several endpoints (requires session authentication if `DASHBOARD_PASSWORD` is set):
- `GET /api/overview`: Retrieve configured metrics.
- `GET /api/metrics/:metric`: Retrieve details and historical timeseries for a specific metric.
- `GET /api/customers`: Search and list customer profiles and timelines.
- `GET /api/reviews`: List reviews, ratings, and linking statuses.
- `GET /api/funnel`: The five funnel steps with per-period counts and conversions. Takes `granularity` (`day`, `week`, `month`, `previous_7_days`), plus the usual `period`/`start`/`end`/`appIds`.
- `GET /api/funnel/apps`: Apps the funnel can be read for — those with a GA4 dataset configured. This is what the page's App filter offers.
- `GET /api/bigquery`: BigQuery account state and per-app sources. The service-account key is write-only and never appears in a response. `POST /api/bigquery/check` verifies the account and lists visible datasets; `POST /api/bigquery/apps/:appId/check` verifies one app's dataset.
- `GET /api/status`: System counts, sync logs, and background worker state.

### Codebase Organization
```
Partner API ──┬── app.events ─────┐
              └── transactions ───┤
                                  ▼
                         raw tables (append-only, idempotent)
                                  │  write-time normalization
                                  ▼
                   subscriptions + install_intervals
                                  │            │  per-install fold
                                  │            ▼
                                  │      customer_events ──► Slack notifications
                                  │            │
                                  │  one as-of predicate
                                  ▼            ▼
                      reports ──► HTTP API ──► dashboard
```

- `src/partner/`: GraphQL client and API integration.
- `src/sync/`: Ingestion, pagination, and write-time normalization.
- `src/metrics/`: Core metric reports and timeseries range calculations.
- `src/appstore/`: Web scraper for App Store listings and reviews.
- `src/bigquery/`: GA4 export connection, credential handling, and listing-traffic ingest.
- `src/notifications/`: Slack webhook dispatcher and templates.
- `web/`: Frontend dashboard single page application (Vite/React).

### Database Validation and Integrity
Run the built-in integrity validator to cross-examine and reconcile internal datasets:
```bash
npm run validate
```
This utility checks source transaction parity, cross-foots reconstructed metrics against database sums, and detects retroactive history drift.

### Limitations
- **Single Currency:** Transactions are summed as-is. Mixed currency billing is not converted.
- **App Store Redesigns:** The review crawler parses raw HTML. Structural modifications by Shopify can affect review collection.
- **Store Name Matching:** Matching App Store review authors with Shopify merchants is a best-effort heuristic based on store names.
- **LTV Calculation:** Periods with zero churn will report an LTV of zero.
- **Funnel Identity:** Steps 1–2 count browsers and steps 3–5 count shops; there is no per-merchant join across that seam, so the conversion between them is directional rather than a true per-visitor rate.
- **Funnel Freshness:** GA4 intraday tables are not read, so the top two steps lag the bottom three by up to a day.
- **Cross-device Identity:** Pre-install events carry no shop, so a merchant is usually a browser. One person on a laptop and a desktop counts as two, and the same person after clearing cookies counts as two.

---

## Sponsors

PartnerDex is free, GPL-3.0, and built in evenings. Sponsorship covers the
hosting it's tested against and buys time to review pull requests.

Sponsors at $25/month:

- [Affilitrak](https://affilitrak.com/)

Want to be on this list? [Sponsor the project](https://github.com/sponsors/AdityaMalani).
Sponsorship is thanks, not leverage. It doesn't buy roadmap influence or a
merged pull request.

---

## License

PartnerDex is licensed under the GNU General Public License v3.0. See the [LICENSE](LICENSE) file for details.
