/** A worker that does the one thing a worker is supposed to do: finish. */
import { reportAndExit } from '../../src/sync/fork.js';

reportAndExit({ ok: true, result: { transactions: 1 } });
