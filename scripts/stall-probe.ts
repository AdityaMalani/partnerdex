/**
 * A fake Partner API that misbehaves in the four ways a real one can, and a
 * probe that drives `paginate()` against each.
 *
 * Not a test — it takes minutes by design, because the whole question is which
 * failures are bounded and which are not. `npm test` covers the same ground with
 * the timeouts turned down; this is the thing you run when you want to watch it
 * happen. Run one mode at a time:
 *
 *   npx tsx scripts/stall-probe.ts silent
 *   npx tsx scripts/stall-probe.ts slow
 *   npx tsx scripts/stall-probe.ts throttled
 *   npx tsx scripts/stall-probe.ts retry-after
 *   npx tsx scripts/stall-probe.ts same-cursor
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { paginate } from '../src/partner/client.js';
import type { PartnerOrg } from '../src/config.js';

type Mode = 'silent' | 'slow' | 'throttled' | 'retry-after' | 'same-cursor';

const mode = (process.argv[2] ?? 'silent') as Mode;

function page(cursor: string, hasNextPage: boolean): string {
  return JSON.stringify({
    data: {
      transactions: {
        pageInfo: { hasNextPage },
        edges: [{ cursor, node: { id: 'gid://partners/Transaction/1', createdAt: '2024-11-26T00:00:00Z' } }],
      },
    },
  });
}

let requests = 0;

function handle(request: IncomingMessage, response: ServerResponse): void {
  requests += 1;
  const at = new Date().toISOString();
  console.log(`[fake] request ${requests} at ${at}`);

  switch (mode) {
    case 'silent':
      // Connection accepted, headers never written. The classic hung socket.
      return;
    case 'slow':
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(page('cursor-1', false));
      }, 30_000);
      return;
    case 'throttled':
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }),
      );
      return;
    case 'retry-after':
      response.writeHead(429, { 'retry-after': '900' });
      response.end('{}');
      return;
    case 'same-cursor':
      // Answers instantly, always says there is more, never moves the cursor.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(page('cursor-1', true));
      return;
  }
}

const server = createServer(handle);

server.listen(0, async () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const org: PartnerOrg = {
    label: 'probe',
    organizationId: '0',
    endpoint: `http://127.0.0.1:${port}/`,
    token: 'token',
  } as PartnerOrg;

  const began = Date.now();
  console.log(`[probe] mode=${mode} started`);
  const report = setInterval(() => {
    console.log(`[probe] still going after ${Math.round((Date.now() - began) / 1000)}s`);
  }, 15_000);

  let pages = 0;
  try {
    for await (const _page of paginate(org, 'query { transactions }', {}, (data: any) => data?.transactions)) {
      pages += 1;
      if (pages % 200 === 0) {
        console.log(`[probe] ${pages} pages in ${Math.round((Date.now() - began) / 1000)}s`);
      }
      if (pages >= 5_000) {
        console.log('[probe] VERDICT: unbounded loop, no cursor movement, no error.');
        break;
      }
    }
    console.log(`[probe] finished after ${Math.round((Date.now() - began) / 1000)}s, ${pages} page(s)`);
  } catch (error) {
    console.log(
      `[probe] threw after ${Math.round((Date.now() - began) / 1000)}s: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearInterval(report);
    server.close();
    process.exit(0);
  }
});
