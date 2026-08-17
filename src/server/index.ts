import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config.js';
import { getCustomer, listCustomers, type CustomerSort } from '../customers/index.js';
import { getDb } from '../db/index.js';
import { type RawMetricQuery } from '../metrics/context.js';
import { HEADLINE_METRICS, listMetrics, runMetric } from '../metrics/registry.js';
import { dispatchPending } from '../notifications/dispatch.js';
import {
  linkCandidates,
  listReviews,
  type ReviewLinkFilter,
  type ReviewSort,
  type ReviewStatusFilter,
} from '../reviews/index.js';
import { setReviewShop } from '../appstore/match.js';
import { buildReviewEvents } from '../appstore/events.js';
import { resolveScopedAppIds } from '../sync/index.js';
import { onSyncComplete, startSyncScheduler, syncStatus } from '../sync/scheduler.js';
import { authRequired, authRouter, requireAuth } from './auth.js';
import { sendError } from './errors.js';
import { notificationsRouter } from './notifications.js';
import { listingsRouter } from './listings.js';
import { bigqueryRouter } from './bigquery.js';
import { listAppSources } from '../bigquery/connection.js';
import { funnelReport } from '../metrics/reports/funnel.js';


function queryOf(request: express.Request): RawMetricQuery {
  const pick = (name: string): string | undefined => {
    const value = request.query[name];
    return typeof value === 'string' ? value : undefined;
  };
  return {
    period: pick('period'),
    start: pick('start'),
    end: pick('end'),
    interval: pick('interval'),
    appIds: pick('appIds'),
    includeAnnual: pick('includeAnnual'),
    includeUsage: pick('includeUsage'),
    includeTrials: pick('includeTrials'),
    byShop: pick('byShop'),
    rating: pick('rating'),
    nocache: pick('nocache'),
  };
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // Behind a TLS-terminating proxy the request arrives as plain HTTP, so
  // `request.protocol` reads "http" and the session cookie would ship without
  // its Secure flag; `request.ip` would be the proxy's, collapsing every failed
  // login into one lockout bucket. One hop, because that is what a proxy in
  // front of this process is — trusting more would trust whatever a client put
  // in the header.
  if (getConfig().runtime.trustProxy) app.set('trust proxy', 1);
  // Only the notification routes accept a body, and the largest of those is a
  // name and a URL. A small ceiling keeps a stray upload from becoming memory.
  app.use(express.json({ limit: '64kb' }));

  // Open by design: a liveness probe that needs a password is not a liveness
  // probe, and it reveals nothing but that the process is up.
  app.get('/api/health', (_request, response) => {
    response.json({ ok: true });
  });

  // Mounted ahead of the gate — one of its jobs is to tell an unauthenticated
  // dashboard that it needs to show a login form.
  app.use('/api/auth', authRouter());

  /*
   * Everything below reads the store, so everything below is gated. The static
   * dashboard bundle deliberately is not: it holds no data, and it has to load
   * before it can ask for the password.
   */
  app.use('/api', requireAuth);

  app.use('/api/notifications', notificationsRouter());
  app.use('/api/listings', listingsRouter());
  app.use('/api/bigquery', bigqueryRouter());

  /**
   * The install funnel.
   *
   * Its own route rather than a metric key, because it is not a time series: it
   * is five steps wide and every column carries a conversion against the one
   * before it, which the single-value metric response has nowhere to put. It
   * still resolves its window through the same ladder and caches in the same
   * table, so there remains exactly one implementation of each figure.
   */
  /**
   * The apps the funnel can actually be read for.
   *
   * Not the same list as `/api/apps`, and deliberately so. A GA4 property covers
   * the one listing whose measurement id points at it, so an app with no dataset
   * configured has no top to its funnel — offering it in the picker only invites
   * a reader to select it and find two steps empty. And there is no "all apps"
   * entry, because summing across apps puts one app's visitors above several
   * apps' installs and produces a conversion rate over 100%.
   */
  app.get('/api/funnel/apps', (_request, response) => {
    try {
      const db = getDb();
      const apps = listAppSources(resolveScopedAppIds(db), db)
        .filter((source) => source.dataset !== null)
        .map((source) => ({
          id: source.appId,
          name: source.appName ?? `App ${source.appId}`,
          // Configured but never synced is a real state, and worth showing
          // differently from configured and flowing.
          hasTraffic: source.eventCount > 0,
        }));
      response.json({ apps });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get('/api/funnel', (request, response) => {
    try {
      const pick = (name: string): string | undefined => {
        const value = request.query[name];
        return typeof value === 'string' ? value : undefined;
      };
      response.json(
        funnelReport({
          period: pick('period'),
          start: pick('start'),
          end: pick('end'),
          granularity: pick('granularity'),
          appIds: pick('appIds'),
          nocache: pick('nocache'),
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get('/api/metrics', (_request, response) => {
    response.json({ metrics: listMetrics() });
  });

  /** Apps in reporting scope, resolved at runtime so no ids live in the code. */
  app.get('/api/apps', (_request, response) => {
    try {
      const db = getDb();
      const scoped = resolveScopedAppIds(db);
      if (scoped.length === 0) {
        response.json({ apps: [] });
        return;
      }
      const placeholders = scoped.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT id, name FROM apps WHERE id IN (${placeholders}) ORDER BY name`)
        .all(...scoped) as Array<{ id: string; name: string }>;
      response.json({ apps: rows });
    } catch (error) {
      sendError(response, error);
    }
  });

  /*
   * The row counts behind this are memoized, and that is not an optimization —
   * without it this route takes the whole process down.
   *
   * SQLite keeps no row count, so `COUNT(*)` walks the table. Measured on the
   * live database: `transactions` 56.5s and `customer_events` 85.0s, together
   * over two minutes of *synchronous* work on the single thread that also serves
   * every other route and answers the health check. No index can help — there is
   * nothing to look up, only rows to count.
   *
   * The dashboard shell polls this on every page for one footer line, so each
   * navigation stalled the entire app and Fly pulled the machine from the load
   * balancer. It presented as "every page hangs", which sent us looking at the
   * pages rather than at the footer.
   *
   * So the counts are now opt-in, behind `?counts=1`, and memoized for a minute
   * when asked for. The dashboard shell reads only `sync` and `lastSyncAt` —
   * verified against the frontend, which never renders a row count anywhere —
   * and both of those are cheap and read fresh on every call, because they are
   * what tells a reader whether the figures in front of them are stale.
   */
  let countsCache: { at: number; value: Record<string, unknown> } | null = null;
  const COUNTS_TTL_MS = 60_000;

  app.get('/api/status', (request, response) => {
    try {
      const db = getDb();

      // Always cheap, and polled on every page.
      const lastSyncAt = (
        db.prepare('SELECT MAX(updated_at) AS lastSyncAt FROM sync_state').get() as {
          lastSyncAt: string | null;
        }
      ).lastSyncAt;

      /*
       * Whether the store holds anything, which the shell needs and used to work
       * out from the row counts above. Making those opt-in would otherwise take
       * the answer away with them: the counts stop arriving, `?? 0` reads the
       * absence as zero, and a store holding millions of rows reports itself
       * empty and tells its operator to run a sync.
       *
       * So the question is answered here instead of reconstructed from figures
       * that happened to be nearby. `LIMIT 1` stops at the first row, which is
       * what lets it stay on the cheap path beside a `COUNT(*)` that could not.
       *
       * Both tables, because either alone is too narrow: a store can hold
       * subscriptions rebuilt from events that carried no sale yet, and it is
       * not empty — it has figures to show.
       */
      const hasData =
        db.prepare('SELECT 1 AS present FROM transactions LIMIT 1').get() !== undefined ||
        db.prepare('SELECT 1 AS present FROM subscriptions LIMIT 1').get() !== undefined;

      const base = { lastSyncAt, hasData, sync: syncStatus() };

      // The counts are opt-in. Callers that want them ask; the shell does not,
      // and used to pay for them on every navigation regardless.
      if (request.query.counts !== '1') {
        response.json(base);
        return;
      }

      if (!countsCache || Date.now() - countsCache.at > COUNTS_TTL_MS) {
        countsCache = {
          at: Date.now(),
          value: db
            .prepare(
              `SELECT
                 (SELECT COUNT(*) FROM apps) AS apps,
                 (SELECT COUNT(*) FROM shops) AS shops,
                 (SELECT COUNT(*) FROM app_events) AS events,
                 (SELECT COUNT(*) FROM transactions) AS transactions,
                 (SELECT COUNT(*) FROM subscriptions) AS subscriptions,
                 (SELECT COUNT(*) FROM customer_events WHERE suppressed = 0) AS customerEvents`,
            )
            .get() as Record<string, unknown>,
        };
      }

      response.json({ ...countsCache.value, ...base });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * One call per dashboard page, so a page renders in a single pass.
   *
   * `metrics=` names what to compute. Every metric costs two reconstructions —
   * its own window and the one before it — so a page asks for the handful of
   * cards it actually shows rather than the whole catalogue.
   */
  app.get('/api/overview', (request, response) => {
    try {
      const query = queryOf(request);
      const requested = typeof request.query.metrics === 'string' ? request.query.metrics : '';
      const wanted = requested
        ? requested.split(',').map((key) => key.trim()).filter(Boolean)
        : HEADLINE_METRICS;

      const results: Record<string, unknown> = {};
      for (const metric of wanted) {
        results[metric] = runMetric(metric, query);
      }
      response.json(results);
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The customer list. Search matches a merchant's display name or their
   * myshopify domain — the two ways a shop is identified outside this tool.
   */
  app.get('/api/customers', (request, response) => {
    try {
      const pick = (name: string): string | undefined => {
        const value = request.query[name];
        return typeof value === 'string' ? value : undefined;
      };
      const appIds = pick('appIds');
      const limit = Number(pick('limit'));
      const offset = Number(pick('offset'));
      response.json(
        listCustomers({
          search: pick('q') ?? '',
          sort: (pick('sort') ?? 'mrr') as CustomerSort,
          limit: Number.isFinite(limit) ? limit : undefined,
          offset: Number.isFinite(offset) ? offset : undefined,
          appIds: appIds ? appIds.split(',').filter(Boolean) : [],
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get('/api/customers/:shopId', (request, response) => {
    try {
      const appIds = typeof request.query.appIds === 'string' ? request.query.appIds : '';
      const detail = getCustomer(request.params.shopId, {
        appIds: appIds ? appIds.split(',').filter(Boolean) : [],
      });
      if (!detail) {
        response.status(404).json({ error: `No customer with shop id ${request.params.shopId}.` });
        return;
      }
      response.json(detail);
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * The review list. Filters are all optional and independent, so the page can
   * ask for "one-star reviews we never matched to a customer" in one request.
   */
  app.get('/api/reviews', (request, response) => {
    try {
      const pick = (name: string): string | undefined => {
        const value = request.query[name];
        return typeof value === 'string' ? value : undefined;
      };
      const appIds = pick('appIds');
      const rating = Number(pick('rating'));
      const limit = Number(pick('limit'));
      const offset = Number(pick('offset'));

      response.json(
        listReviews({
          search: pick('q') ?? '',
          appIds: appIds ? appIds.split(',').filter(Boolean) : [],
          rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
          status: (pick('status') ?? 'all') as ReviewStatusFilter,
          linked: (pick('linked') ?? 'all') as ReviewLinkFilter,
          sort: (pick('sort') ?? 'newest') as ReviewSort,
          limit: Number.isFinite(limit) ? limit : undefined,
          offset: Number.isFinite(offset) ? offset : undefined,
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  /** Shops offered when linking a review by hand. */
  app.get('/api/reviews/:reviewId/candidates', (request, response) => {
    try {
      const search = typeof request.query.q === 'string' ? request.query.q : '';
      response.json({ candidates: linkCandidates(request.params.reviewId, search) });
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Linking a review to a customer by hand, and unlinking it again.
   *
   * A body of `{ shopId: null }` clears the link and hands the review back to
   * the automatic matcher, which is the way out of a mistaken link rather than
   * being stuck with it. Both take effect immediately; the next sync's rebuild
   * is what carries the change onto the customer's timeline.
   */
  app.put('/api/reviews/:reviewId/shop', (request, response) => {
    try {
      const body = request.body as { shopId?: unknown };
      const shopId =
        body?.shopId === null || body?.shopId === undefined ? null : String(body.shopId);

      if (shopId !== null) {
        const exists = getDb().prepare('SELECT 1 FROM shops WHERE id = ?').get(shopId);
        if (!exists) {
          response.status(400).json({ error: `No customer with shop id ${shopId}.` });
          return;
        }
      }

      if (!setReviewShop(getDb(), request.params.reviewId, shopId)) {
        response.status(404).json({ error: `No review with id ${request.params.reviewId}.` });
        return;
      }

      // Recompile straight away so the customer's timeline agrees with the link
      // the reader just made, rather than only after the next sync.
      buildReviewEvents(getDb());
      response.json({ ok: true, shopId, matchMethod: shopId ? 'manual' : 'none' });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get('/api/metrics/:metric', (request, response) => {
    try {
      response.json(runMetric(request.params.metric, queryOf(request)));
    } catch (error) {
      sendError(response, error);
    }
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const webRoot = path.resolve(here, '../web');
  if (fs.existsSync(webRoot)) {
    app.use(express.static(webRoot));
    app.get('*', (_request, response) => {
      response.sendFile(path.join(webRoot, 'index.html'));
    });
  }

  return app;
}

/**
 * Notifications ride on the sync loop rather than a clock of their own.
 *
 * A subscription event does not exist locally until a sync has pulled it and
 * the compiler has classified it, so any other cadence would either poll a
 * store that had nothing new or race the rebuild that produces the rows. A
 * failed run is skipped outright: nothing was written, so there is nothing to
 * announce.
 */
function startNotifier(): void {
  onSyncComplete((outcome) => {
    if (outcome.error) return;
    dispatchPending().then(
      (summary) => {
        if (summary.sent > 0 || summary.retired > 0) {
          console.log(
            `[partnerdex] notifications: ${summary.sent} sent` +
              `${summary.retired > 0 ? `, ${summary.retired} undeliverable` : ''}` +
              `${summary.deferred > 0 ? `, ${summary.deferred} deferred` : ''}.`,
          );
        }
      },
      // The listener contract is synchronous, so the scheduler's try/catch
      // cannot see a rejected promise. Catch it here or it is unhandled.
      (cause) => console.error('[partnerdex] notification dispatch failed:', cause),
    );
  });
}

export function serve(): void {
  const { runtime } = getConfig();
  createApp().listen(runtime.port, () => {
    console.log(`partnerdex listening on http://localhost:${runtime.port}`);
    console.log(
      authRequired()
        ? 'partnerdex dashboard requires the DASHBOARD_PASSWORD login.'
        : 'partnerdex dashboard is open to anyone who can reach the port. ' +
            'Set DASHBOARD_PASSWORD in .env to require a login.',
    );

    startNotifier();

    // Started only once the port is open, so a slow first sync never delays
    // the dashboard coming up.
    const status = startSyncScheduler();
    console.log(
      status.enabled
        ? `partnerdex syncing every ${status.intervalMinutes} minute(s). ` +
            `Set SYNC_INTERVAL_MINUTES=0 to turn it off.`
        : 'partnerdex background sync is off (SYNC_INTERVAL_MINUTES=0). Run `partnerdex sync`.',
    );
  });
}
