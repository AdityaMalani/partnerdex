import express from 'express';
import { getDb } from '../db/index.js';
import {
  BigQueryError,
  describe,
  listAppSources,
  readConnection,
  removeConnection,
  saveAppSource,
  saveConnection,
} from '../bigquery/connection.js';
import { checkAppSource, checkConnection } from '../bigquery/ingest.js';
import { bigquerySyncJob, startBigquerySync } from '../sync/bigquerySyncJob.js';
import { resolveScopedAppIds } from '../sync/index.js';
import { sendError } from './errors.js';

/**
 * The BigQuery settings API.
 *
 * One rule shapes all of it: the service-account key goes in and never comes
 * out. `describe` is the only thing that ever renders a stored connection, and
 * it returns the account's email and the last of its key id — enough to answer
 * "which key is this?" and useless to anyone who intercepts it.
 *
 * The routes come in two levels, matching the data. `/` is the account — one
 * project, one key. `/apps/:appId` is where a GA4 export actually lives, which
 * is per app because a partner who put a separate measurement id on each
 * listing has a dataset per listing.
 *
 * Both levels have a check, and they answer different questions. The account
 * check proves the credential and lists the datasets it can see; the app check
 * proves one of those datasets really is a GA4 export and how far back it goes.
 * Both read INFORMATION_SCHEMA, so neither scans a byte of event data.
 */
export function bigqueryRouter(): express.Router {
  const router = express.Router();

  const payload = () => {
    const db = getDb();
    const connection = readConnection(db);
    const scoped = resolveScopedAppIds(db);
    const stats = db
      .prepare(
        `SELECT COUNT(*) AS events,
                MIN(occurred_at) AS earliest,
                MAX(occurred_at) AS latest
           FROM listing_events`,
      )
      .get() as { events: number; earliest: string | null; latest: string | null };

    return {
      connection: connection ? describe(connection) : null,
      sources: listAppSources(scoped, db),
      stats,
      // The manual ingest is a background job now, so its progress has to be
      // readable from the surface that already polls — otherwise a 202 is the
      // last thing anyone ever hears about the run they started.
      job: bigquerySyncJob(),
    };
  };

  router.get('/', (_request, response) => {
    try {
      response.json(payload());
    } catch (error) {
      sendError(response, error);
    }
  });

  router.put('/', (request, response) => {
    try {
      const body = request.body as Record<string, unknown>;
      const text = (key: string): string | undefined =>
        typeof body?.[key] === 'string' ? (body[key] as string) : undefined;

      if (!text('projectId')) {
        throw new BigQueryError('A Google Cloud project id is required.');
      }

      saveConnection({
        projectId: text('projectId')!,
        location: text('location'),
        // Absent on an edit that leaves the key alone; the stored one stands.
        credentials: text('credentials'),
      });

      response.json(payload());
    } catch (error) {
      sendError(response, error);
    }
  });

  router.delete('/', (_request, response) => {
    try {
      if (!removeConnection()) {
        response.status(404).json({ error: 'BigQuery is not connected.' });
        return;
      }
      // The events already collected are kept. They are a year of listing
      // traffic that GA4 may no longer be able to re-serve, and disconnecting a
      // credential is not a request to throw the history away.
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Proves the credential and the project, and lists the datasets the account
   * can see — which is what the per-app dataset fields then choose from.
   */
  router.post('/check', (_request, response) => {
    checkConnection(getDb())
      .then((check) => response.json({ check, ...payload() }))
      .catch((error: unknown) => sendError(response, error));
  });

  /** Proves one app's dataset really is a GA4 export, and how far back it goes. */
  router.post('/apps/:appId/check', (request, response) => {
    checkAppSource(request.params.appId, getDb())
      .then((check) => response.json({ check, ...payload() }))
      .catch((error: unknown) => sendError(response, error));
  });

  /**
   * Sets one app's source. An empty string clears a field — which for the
   * dataset stops the app syncing, and for the rest hands it back to its
   * default (the listing handle, the app's api key, the connection's location).
   */
  router.put('/apps/:appId', (request, response) => {
    try {
      const body = request.body as Record<string, unknown>;
      const text = (key: string): string | null | undefined => {
        const value = body?.[key];
        return typeof value === 'string' ? value : undefined;
      };
      response.json(
        saveAppSource(request.params.appId, {
          dataset: text('dataset'),
          location: text('location'),
          handle: text('handle'),
          apiKey: text('apiKey'),
        }),
      );
    } catch (error) {
      sendError(response, error);
    }
  });

  /**
   * Starts a pull of listing traffic rather than waiting for the sync loop.
   *
   * `full` re-reads from the backfill floor, which is what a partner wants
   * immediately after fixing a dataset or a handle: the watermark from the
   * broken configuration would otherwise skip everything it already walked past.
   *
   * Accepts a *job* rather than performing the ingest, because performing it
   * here is what took the production machine out of the load balancer: up to
   * millions of synchronous SQLite inserts on the thread that answers the health
   * probe. `startBigquerySync` forks the same kind of child the scheduler has
   * always used, and refuses to start a second run alongside one already going —
   * two ingests would advance the same watermarks against a single-writer
   * database.
   *
   * 202 rather than 200 because the work has not happened yet, and the response
   * body says so: poll `GET /api/bigquery` and read `job`.
   */
  router.post('/sync', (request, response) => {
    try {
      const full = request.query.full === '1' || request.query.full === 'true';
      const { accepted } = startBigquerySync({ full });
      if (!accepted) {
        // `payload()` carries the same job, so it is not repeated here.
        response.status(409).json({
          error: 'A BigQuery sync is already running. Wait for it to finish.',
          ...payload(),
        });
        return;
      }
      response.status(202).json({ accepted: true, ...payload() });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
