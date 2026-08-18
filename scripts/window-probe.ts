/**
 * A fake Partner API with a real history behind it, and a probe that asks one
 * question: when a pass resumes from a stored cursor, how many rows does it
 * walk?
 *
 * The observation that prompted this was a pass that walked millions of rows
 * when its window held tens of thousands. Two explanations fit that shape and
 * only one of them involves the cursor:
 *
 *   1. the cursor outlives the window it was made for — a Relay cursor is a
 *      position in *the query that produced it*, so handing it to a query with
 *      a different `createdAtMin` resumes the old walk, not the new one; or
 *   2. `createdAtMin` never narrowed the connection at all, in which case every
 *      pass re-walks all history and the cursor is innocent.
 *
 * They cannot be told apart from a row count alone, so both are staged here.
 * The server has three behaviours, and the probe runs the same three scenarios
 * against each; the table it prints says which combinations can produce an
 * over-walk and which cannot.
 *
 *   npx tsx scripts/window-probe.ts
 *   npx tsx scripts/window-probe.ts --rows 400000 --days 400 --window 3
 *
 * Not a test — `test/syncWatermark.test.ts` covers the fix at a size that runs
 * in milliseconds. This is the thing you run when you want to watch it happen
 * at a size where the difference is measured in millions of rows.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { paginate } from '../src/partner/client.js';
import { transactionVariables } from '../src/sync/index.js';
import { SALE_TRANSACTION_TYPES } from '../src/partner/queries.js';
import type { PartnerOrg } from '../src/config.js';

/**
 * How the connection treats its two arguments.
 *
 *   anchored   — `createdAtMin` narrows a fresh query, and a cursor resumes the
 *                walk it was cut from. This is what a Relay cursor means: an
 *                opaque position in one query's result set, not a timestamp.
 *   filtered   — `createdAtMin` narrows every query, cursor or no cursor. The
 *                server a client would like to have.
 *   unfiltered — `createdAtMin` is accepted and ignored. Explanation 2.
 */
type Mode = 'anchored' | 'filtered' | 'unfiltered';

interface Options {
  rows: number;
  days: number;
  window: number;
  pageSize: number;
}

function parseOptions(argv: string[]): Options {
  const read = (name: string, fallback: number): number => {
    const at = argv.indexOf(`--${name}`);
    if (at < 0) return fallback;
    const value = Number(argv[at + 1]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    rows: read('rows', 400_000),
    days: read('days', 400),
    window: read('window', 3),
    pageSize: read('page-size', 100),
  };
}

const options = parseOptions(process.argv.slice(2));

/**
 * History, oldest first, spread evenly over the configured span and ending now.
 *
 * Only the timestamp is kept per row; the probe counts rows and never ingests
 * them, so a full transaction node per row would buy nothing but memory.
 */
const NOW = Date.parse('2026-08-15T12:00:00Z');
const SPAN_MS = options.days * 86_400_000;
const history: string[] = Array.from({ length: options.rows }, (_, index) =>
  new Date(NOW - SPAN_MS + Math.round((SPAN_MS * index) / options.rows)).toISOString(),
);

/** The window a healthy incremental pass would ask for. */
const windowStart = new Date(NOW - options.window * 86_400_000).toISOString();
const windowRows = history.filter((at) => at >= windowStart).length;

/**
 * A cursor is opaque to the client and meaningful only to the server that
 * issued it. Here it carries the absolute position in history, which is what an
 * offset-backed connection stores — and precisely why it cannot be reinterpreted
 * under a different filter.
 */
function encode(index: number): string {
  return Buffer.from(`row:${index}`).toString('base64');
}

function decode(cursor: string): number {
  return Number(Buffer.from(cursor, 'base64').toString('utf8').replace('row:', ''));
}

let mode: Mode = 'anchored';
let served = 0;

function respond(request: IncomingMessage, response: ServerResponse, body: string): void {
  request.resume();
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(body);
}

function handle(request: IncomingMessage, response: ServerResponse): void {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const { variables } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      variables: { after?: string | null; createdAtMin?: string };
    };
    served += 1;

    const after = variables.after ?? null;
    const min = variables.createdAtMin ?? '';

    // Where in history this page starts, and whether the time filter applies to
    // it. `anchored` is the whole point: a cursor resumes its original walk, so
    // the filter supplied alongside it is not applied.
    const from = after === null ? 0 : decode(after) + 1;
    const applyFilter = mode === 'filtered' || (mode === 'anchored' && after === null);

    const edges: Array<{ cursor: string; node: unknown }> = [];
    let index = from;
    for (; index < history.length && edges.length < options.pageSize; index += 1) {
      const at = history[index] as string;
      if (applyFilter && at < min) continue;
      edges.push({ cursor: encode(index), node: { id: `gid://partners/Transaction/${index}`, createdAt: at } });
    }

    respond(
      request,
      response,
      JSON.stringify({
        data: { transactions: { pageInfo: { hasNextPage: index < history.length }, edges } },
      }),
    );
  });
}

/**
 * The three states a pass can start in.
 *
 * `staleCursor` is the one under investigation: a cursor left behind by a pass
 * that was walking a *wider* window — a first backfill, or a `--full` run — and
 * then killed, handed to a pass whose window is the last few days.
 */
const scenarios: Array<{ name: string; cursor: string | null; note: string }> = [
  { name: 'clean start', cursor: null, note: 'no cursor, incremental window' },
  {
    name: 'same-window resume',
    cursor: encode(history.length - Math.round(windowRows / 2)),
    note: 'cursor from a pass over this same window',
  },
  {
    name: 'stale-window resume',
    cursor: encode(Math.round(history.length * 0.4)),
    note: 'cursor from a pass over all history',
  },
];

async function walk(org: PartnerOrg, cursor: string | null): Promise<{ rows: number; ms: number }> {
  const began = Date.now();
  let rows = 0;
  for await (const page of paginate(
    org,
    'query PartnerdexTransactions { transactions }',
    transactionVariables(null, windowStart, SALE_TRANSACTION_TYPES),
    (data: any) => data?.transactions,
    cursor,
  )) {
    rows += page.nodes.length;
  }
  return { rows, ms: Date.now() - began };
}

const server = createServer(handle);

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const org = {
    label: 'probe',
    organizationId: '0',
    endpoint: `http://127.0.0.1:${port}/`,
    token: 'token',
  } as PartnerOrg;

  console.log(
    `[probe] ${history.length} rows over ${options.days} days; ` +
      `the ${options.window}-day window holds ${windowRows}`,
  );

  for (const next of ['anchored', 'filtered', 'unfiltered'] as Mode[]) {
    mode = next;
    for (const scenario of scenarios) {
      served = 0;
      const { rows, ms } = await walk(org, scenario.cursor);
      const verdict = rows > windowRows * 2 ? 'OVER-WALK' : 'bounded';
      console.log(
        `[${mode}] ${scenario.name.padEnd(20)} ${String(rows).padStart(8)} rows in ${
          String(ms).padStart(6)
        }ms over ${String(served).padStart(6)} requests  ${verdict}  (${scenario.note})`,
      );
    }
  }

  server.close();
  process.exit(0);
});
