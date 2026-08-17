/**
 * A worker that reports once and then never finishes — production's stall,
 * reduced to nine lines.
 *
 * It sends one update so the parent has seen it start, then parks forever on a
 * timer it never clears. Nothing here exits, throws or closes the IPC channel,
 * which is exactly why the parent used to wait for it until the machine was
 * restarted.
 */
import { reportUpdate } from '../../src/sync/fork.js';

reportUpdate({ phase: 'transactions', org: 'acme', state: 'start', startedAt: new Date().toISOString(), elapsedMs: 0, idleMs: 0 });

setInterval(() => {}, 1_000);
