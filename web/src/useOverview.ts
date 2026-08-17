/**
 * The overview grid, fetched one card at a time.
 *
 * A page used to ask for every metric it shows in a single `/api/overview` call
 * and set state once, when all of them had returned. That makes the page as slow
 * as its slowest card and as reliable as its least reliable one: one metric that
 * takes half a minute holds five that took a second, and one metric that throws
 * replaces the whole grid with an error.
 *
 * Neither of those follows from anything. The endpoint already accepts
 * `?metrics=a,b,c`, so a card is a request of its own, and a card is the unit
 * the reader actually cares about. This hook fetches them separately and reports
 * each one's state independently — arrived, still coming, or failed — which is
 * what lets the grid paint the fast figures immediately and confine a failure to
 * the one card that suffered it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchOverview, type MetricResponse, type QueryState } from './api';

export interface CardState {
  status: 'loading' | 'ready' | 'error';
  /**
   * The last figure that arrived for this card, if one ever did.
   *
   * Kept across a refresh on purpose, and kept across a *failed* refresh too: a
   * number that is a minute old and says so is worth more than an empty card.
   * Cleared only when the page changes, because a different page shows a
   * different set of cards and the old figures do not belong to any of them.
   */
  metric?: MetricResponse;
  /** Set when `status` is `error`; what the server or the network said. */
  error?: string;
}

export type CardStates = Record<string, CardState>;

/**
 * How many card requests may be in flight at once.
 *
 * Not a performance tuning knob so much as a courtesy one. A page can show
 * seven cards, browsers cap connections per host at six, and the dashboard has
 * other things to ask for — the status poll, the app list, whatever the page
 * itself fetches. Leaving headroom keeps those from queueing behind a grid.
 */
const CONCURRENCY = 4;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : 'The request failed.';

export interface OverviewCards {
  /** One entry per requested metric, from the moment the request is issued. */
  cards: CardStates;
  /** True until every card has either arrived or failed. */
  loading: boolean;
  /**
   * Set only when every card failed, which is the shape a server that is down
   * takes. One card failing is the card's business and is reported on the card.
   */
  outage: string | null;
  /** Re-request a single card, leaving the rest of the grid alone. */
  retry: (metric: string) => void;
}

export function useOverviewCards(
  query: QueryState,
  metrics: string[],
  /** Cards are cleared when this changes. The page id, in practice. */
  resetKey: string,
  /** Bumped when a sync lands; re-requests everything, in place. */
  dataVersion: number,
): OverviewCards {
  const [cards, setCards] = useState<CardStates>({});

  /*
   * Cleared during render rather than in an effect, for the same reason the
   * page's filter defaults are: an effect runs after the new page has already
   * mounted, so the reader would see one frame of the previous page's figures
   * under the new page's labels. React discards this render and re-runs it
   * before any child sees the state.
   */
  const [shownFor, setShownFor] = useState(resetKey);
  if (shownFor !== resetKey) {
    setShownFor(resetKey);
    setCards({});
  }

  /*
   * A response is only allowed to write to state if the request that produced it
   * still describes what is on screen. Every refetch bumps this, so a slow card
   * from the previous window cannot land on top of the current one — the reason
   * a plain `cancelled` flag is not enough here is `retry`, which starts a
   * request outside the effect that would own such a flag.
   */
  const generation = useRef(0);
  /** What `retry` should re-ask with, without making it re-created per render. */
  const current = useRef(query);
  current.current = query;

  useEffect(() => {
    if (metrics.length === 0) {
      setCards({});
      return;
    }

    generation.current += 1;
    const mine = generation.current;
    const fresh = () => generation.current === mine;

    setCards((previous) => {
      const next: CardStates = {};
      for (const metric of metrics) {
        // Same metrics, new window: hold the figure already on screen and let
        // it be replaced in place. A page change cleared this map above, so
        // there is nothing to hold and the card starts empty.
        next[metric] = { status: 'loading', metric: previous[metric]?.metric };
      }
      return next;
    });

    const queue = [...metrics];
    const worker = async (): Promise<void> => {
      for (;;) {
        const metric = queue.shift();
        if (metric === undefined || !fresh()) return;
        try {
          const result = await fetchOverview(current.current, [metric]);
          if (!fresh()) return;
          const response = result[metric];
          setCards((state) => ({
            ...state,
            [metric]: response
              ? { status: 'ready', metric: response }
              : {
                  status: 'error',
                  // A 200 that does not carry the metric that was asked for is
                  // still a failure of this card, and reads as one.
                  error: 'The server returned no figure for this card.',
                  metric: state[metric]?.metric,
                },
          }));
        } catch (cause) {
          if (!fresh()) return;
          setCards((state) => ({
            ...state,
            [metric]: { status: 'error', error: messageOf(cause), metric: state[metric]?.metric },
          }));
        }
      }
    };

    void Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, metrics.length) }, () => worker()),
    );

    return () => {
      // Nothing to abort — the responses are simply no longer ours to write.
      generation.current += 1;
    };
    // `dataVersion` is the refresh trigger: a completed sync re-runs the same
    // requests so the figures move in place, without a spinner or a reload.
  }, [query, metrics, dataVersion]);

  const retry = useCallback((metric: string) => {
    const mine = generation.current;
    setCards((state) => ({ ...state, [metric]: { status: 'loading', metric: state[metric]?.metric } }));
    fetchOverview(current.current, [metric])
      .then((result) => {
        if (generation.current !== mine) return;
        const response = result[metric];
        setCards((state) => ({
          ...state,
          [metric]: response
            ? { status: 'ready', metric: response }
            : {
                status: 'error',
                error: 'The server returned no figure for this card.',
                metric: state[metric]?.metric,
              },
        }));
      })
      .catch((cause: unknown) => {
        if (generation.current !== mine) return;
        setCards((state) => ({
          ...state,
          [metric]: { status: 'error', error: messageOf(cause), metric: state[metric]?.metric },
        }));
      });
  }, []);

  const entries = metrics.map((metric) => cards[metric]);
  const loading = entries.some((state) => state === undefined || state.status === 'loading');
  const outage =
    metrics.length > 0 && entries.every((state) => state?.status === 'error')
      ? entries[0]?.error ?? 'The request failed.'
      : null;

  return { cards, loading, outage, retry };
}
