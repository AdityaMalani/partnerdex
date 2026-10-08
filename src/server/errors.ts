import type express from 'express';
import { ContactsError } from '../contacts/upsert.js';
import { MetricRequestError } from '../metrics/context.js';
import { TimeRangeError } from '../metrics/time.js';
import { NotificationError } from '../notifications/store.js';
import { ListingError } from '../appstore/listings.js';
import { BigQueryError } from '../bigquery/connection.js';

/**
 * The one place an exception becomes a status code.
 *
 * Errors this project raises deliberately carry a message meant for a reader;
 * everything else is assumed to leak internals and is replaced with a generic
 * 500, with the detail going to the server log instead.
 */
export function sendError(response: express.Response, error: unknown): void {
  if (error instanceof MetricRequestError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof ContactsError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof NotificationError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof ListingError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof BigQueryError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof TimeRangeError) {
    response.status(400).json({ error: error.message });
    return;
  }
  console.error('[partnerdex]', error);
  response.status(500).json({ error: 'Internal error. See the server log for details.' });
}
