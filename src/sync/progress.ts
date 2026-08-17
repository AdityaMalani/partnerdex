/**
 * What a sync says about itself while it runs.
 *
 * The sync already had a progress callback, but it was a bare string handed to
 * whoever asked. The CLI printed every line; the background loop passed nothing
 * at all, so a pass that ran for an hour in a forked child produced exactly one
 * log line — the one the scheduler printed when it started — and nothing else
 * until it finished. A stalled pass and a busy one looked identical from
 * outside, and `/api/status` could say only `running: true`.
 *
 * This module is the shape that fixes it. A run is a sequence of named
 * **phases**; each phase reports when it began, when it ended, how long it took
 * and what it produced. Between the two ends a **heartbeat** repeats the phase,
 * its elapsed time, and the most recent detail line, so "working" is
 * distinguishable from "hung" without attaching a debugger.
 *
 * The detail lines themselves are deliberately *not* logged. A large connection
 * is thousands of pages and every one of them calls `progress()`; a process that
 * runs every few minutes for months cannot print a line per page. The reporter
 * remembers the last one and the heartbeat carries it, which answers the only
 * question the operator was going to ask of it — "how far has it got?" — at a
 * volume that does not fill a disk.
 */

/** ISO instant, kept as a string because that is what crosses the IPC boundary. */
type Instant = string;

export type PhaseState = 'start' | 'heartbeat' | 'end' | 'error';

export interface PhaseEvent {
  /** Stable, machine-readable name of the phase: `transactions`, `derive`, ... */
  phase: string;
  /** The organization this phase belongs to, where it belongs to one. */
  org: string | null;
  state: PhaseState;
  startedAt: Instant;
  /** Milliseconds since the phase began. Zero on `start`. */
  elapsedMs: number;
  /** Milliseconds since anything at all was reported. Sized to spot a stall. */
  idleMs: number;
  /** What the phase produced, on `end`. */
  counts?: Record<string, number>;
  /** The most recent detail line, on `heartbeat`. */
  message?: string;
  /** Why the phase ended, on `error`. */
  error?: string;
}

export interface SyncObserver {
  /** Phase transitions and heartbeats. This is the one worth logging. */
  onPhase?(event: PhaseEvent): void;
  /** Every detail line, unthrottled. The CLI wants this; a daemon does not. */
  onProgress?(message: string): void;
}

/**
 * How often a phase in flight says it is still there.
 *
 * Short enough that an operator watching `fly logs` sees a sign of life before
 * they start doubting the process, long enough that a pass which legitimately
 * takes an hour adds a hundred-odd lines rather than thousands.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface PhaseHandle {
  /** Close the phase as successful, with whatever it counted. */
  ok(counts?: Record<string, number>): void;
  /** Close the phase as failed. Returns the error so callers can rethrow it. */
  fail(cause: unknown): Error;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The run's own narrator.
 *
 * One per `runSync`. It owns a single heartbeat timer for the whole run rather
 * than one per phase, because phases nest (an org's transactions sit inside that
 * org's pass) and two timers would say the same thing twice.
 */
export class SyncReporter {
  readonly #observer: SyncObserver;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | null = null;
  #stack: Array<{ phase: string; org: string | null; began: number; startedAt: Instant }> = [];
  #lastMessage: string | null = null;

  /**
   * When anything last happened: a phase boundary or a detail line.
   *
   * This is the clock a stall is measured against, and it is deliberately *not*
   * advanced by heartbeats. A heartbeat proves the event loop is turning, which
   * a process parked on a socket that will never answer also manages. Only real
   * progress moves this.
   */
  #lastActivity: number = Date.now();

  constructor(observer: SyncObserver = {}, intervalMs: number = HEARTBEAT_INTERVAL_MS) {
    this.#observer = observer;
    this.#intervalMs = intervalMs;
  }

  /** Milliseconds since the run last made real progress. */
  idleMs(now: number = Date.now()): number {
    return now - this.#lastActivity;
  }

  /** The phase in flight, innermost first, or null between phases. */
  current(): { phase: string; org: string | null; startedAt: Instant } | null {
    const top = this.#stack.at(-1);
    return top ? { phase: top.phase, org: top.org, startedAt: top.startedAt } : null;
  }

  lastMessage(): string | null {
    return this.#lastMessage;
  }

  /** A detail line: remembered, forwarded, never logged by this module. */
  progress(line: string): void {
    this.#lastMessage = line;
    this.#lastActivity = Date.now();
    this.#observer.onProgress?.(line);
  }

  /** The `onProgress` callback to hand to a step that only knows about strings. */
  progressCallback(): (line: string) => void {
    return (line) => this.progress(line);
  }

  begin(phase: string, org: string | null = null): PhaseHandle {
    const began = Date.now();
    const startedAt = new Date(began).toISOString();
    this.#stack.push({ phase, org, began, startedAt });
    this.#lastMessage = null;
    this.#lastActivity = began;
    this.#emit({ phase, org, state: 'start', startedAt, elapsedMs: 0, idleMs: 0 });
    this.#ensureHeartbeat();

    let closed = false;
    const close = (state: 'end' | 'error', extra: Partial<PhaseEvent>): void => {
      if (closed) return;
      closed = true;
      // Phases close in the order they opened; the guard is for a caller that
      // throws between two `begin`s and unwinds out of order anyway.
      const index = this.#stack.findIndex((entry) => entry.began === began && entry.phase === phase);
      if (index >= 0) this.#stack.splice(index, 1);
      const now = Date.now();
      this.#lastActivity = now;
      this.#emit({
        phase,
        org,
        state,
        startedAt,
        elapsedMs: now - began,
        idleMs: 0,
        ...extra,
      });
      this.#stopHeartbeatIfIdle();
    };

    return {
      ok: (counts) => close('end', counts ? { counts } : {}),
      fail: (cause) => {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        close('error', { error: message(error) });
        return error;
      },
    };
  }

  /** Run `work` as one phase, closing it either way. */
  async phase<T>(
    phase: string,
    org: string | null,
    work: () => Promise<T>,
    counts?: (value: T) => Record<string, number>,
  ): Promise<T> {
    const handle = this.begin(phase, org);
    try {
      const value = await work();
      handle.ok(counts?.(value));
      return value;
    } catch (cause) {
      throw handle.fail(cause);
    }
  }

  /** Release the heartbeat timer. Safe to call more than once. */
  close(): void {
    this.#stack = [];
    this.#stopHeartbeat();
  }

  #emit(event: PhaseEvent): void {
    try {
      this.#observer.onPhase?.(event);
    } catch {
      // A broken observer is not allowed to break the sync it is watching.
    }
  }

  #ensureHeartbeat(): void {
    if (this.#timer || this.#intervalMs <= 0) return;
    this.#timer = setInterval(() => this.#beat(), this.#intervalMs);
    // Never the reason a process refuses to exit.
    this.#timer.unref?.();
  }

  #stopHeartbeatIfIdle(): void {
    if (this.#stack.length === 0) this.#stopHeartbeat();
  }

  #stopHeartbeat(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  #beat(): void {
    const top = this.#stack.at(-1);
    if (!top) return;
    const now = Date.now();
    this.#emit({
      phase: top.phase,
      org: top.org,
      state: 'heartbeat',
      startedAt: top.startedAt,
      elapsedMs: now - top.began,
      idleMs: this.idleMs(now),
      ...(this.#lastMessage ? { message: this.#lastMessage } : {}),
    });
  }
}

/* ------------------------------------------------------------------ writing */

function seconds(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}

function subject(event: PhaseEvent): string {
  return event.org ? `${event.phase}/${event.org}` : event.phase;
}

function countList(counts: Record<string, number> | undefined): string {
  if (!counts) return '';
  const parts = Object.entries(counts).map(([name, value]) => `${name}=${value}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/**
 * One phase event as one line of log.
 *
 * Kept here rather than in the worker so the CLI, the worker and a test all
 * agree on what a sync looks like when it talks.
 */
export function formatPhaseEvent(event: PhaseEvent): string {
  const where = subject(event);
  switch (event.state) {
    case 'start':
      return `${where}: begin`;
    case 'heartbeat': {
      const detail = event.message ? ` ${event.message.trim()}` : '';
      const idle = event.idleMs >= HEARTBEAT_INTERVAL_MS * 2 ? `, idle ${seconds(event.idleMs)}` : '';
      return `${where}: working ${seconds(event.elapsedMs)}${idle} -${detail || ' no detail yet'}`;
    }
    case 'end':
      return `${where}: done in ${seconds(event.elapsedMs)}${countList(event.counts)}`;
    case 'error':
      return `${where}: FAILED after ${seconds(event.elapsedMs)}: ${event.error ?? 'unknown cause'}`;
  }
}
