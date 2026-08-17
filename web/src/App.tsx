import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchApps,
  fetchFunnelApps,
  fetchOverview,
  fetchSession,
  fetchStatus,
  logout,
  SIGNED_OUT_EVENT,
  type AppSummary,
  type FunnelApp,
  type Granularity,
  type Overview,
  type QueryState,
  type Session,
  type Status,
} from './api';
import { formatDateTime } from './format';
import { CustomerDetail } from './components/CustomerDetail';
import { Customers } from './components/Customers';
import { Login } from './components/Login';
import { MetricCard } from './components/MetricCard';
import { Nav } from './components/Nav';
import { Listings } from './components/Listings';
import { BigQuery } from './components/BigQuery';
import { Funnel } from './components/Funnel';
import { Notifications } from './components/Notifications';
import { UnmatchedReviews } from './components/Reviews';
import { DEFAULT_FILTERS, metricsFor, pageById } from './pages';

const PERIODS = [
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_30_days', label: 'Last 30 days' },
  { value: 'last_90_days', label: 'Last 90 days' },
  { value: 'last_12_months', label: 'Last 12 months' },
  { value: 'year_to_date', label: 'Year to date' },
  { value: 'all_time', label: 'All time' },
];

/**
 * Funnel column widths.
 *
 * The last one is not a granularity in the same sense as the others — it is one
 * column covering the last seven days — so choosing it fixes the range too, and
 * the Range control beside it goes quiet rather than pretending to apply.
 */
const GRANULARITIES: Array<{ value: Granularity; label: string }> = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
  { value: 'month', label: 'Monthly' },
  { value: 'previous_7_days', label: 'Previous 7 days, grouped' },
];

/**
 * How often to ask the server whether it has synced. Well under the default
 * five-minute sync cadence, so new figures surface within a minute of landing,
 * and cheap enough that an idle tab costs nothing worth counting.
 */
const STATUS_POLL_MS = 60_000;

const THEME_KEY = 'partnerdex:theme';

/**
 * Two states, dark by default. The choice is written to the element and to
 * storage together, so the inline script in index.html can settle the theme
 * before the first paint on the next load.
 */
function useTheme(): ['dark' | 'light', () => void] {
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  );

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      window.localStorage.setItem(THEME_KEY, next);
      return next;
    });
  }, []);

  return [theme, toggle];
}

/**
 * The overview opens with a greeting rather than a page title, because it is
 * the page a reader lands on. The hour is the only thing it knows about them,
 * so that is what it uses; the sentence underneath still says what the page is.
 */
function greeting(): { title: string; blurb: string } {
  const hour = new Date().getHours();

  if (hour < 5) {
    return {
      title: 'Still up? Welcome back',
      blurb: "The quiet hours are the best ones for reading numbers. Here's how the business stands.",
    };
  }
  if (hour < 12) {
    return {
      title: 'Good morning — welcome back',
      blurb: "Fresh coffee, fresh figures. Here's your business at a glance.",
    };
  }
  if (hour < 18) {
    return {
      title: 'Good afternoon — welcome back',
      blurb: "Here's where the business stands right now, in five figures.",
    };
  }
  return {
    title: 'Good evening — welcome back',
    blurb: "Winding down? Here's how the day left your business.",
  };
}

/**
 * Hash routing rather than a router: the page id lives in the URL so a report
 * can be linked and survives a reload, and the server's catch-all never has to
 * know about client routes.
 *
 * One segment deep is enough — `#/customers/12345` opens one merchant — which
 * keeps a single merchant as linkable as a report.
 */
function useRoute(): { pageId: string; param: string } {
  const read = () => {
    const raw = window.location.hash.replace(/^#\/?/, '');
    const [pageId = 'overview', param = ''] = raw.split('/');
    return { pageId: pageId || 'overview', param: decodeURIComponent(param) };
  };
  const [route, setRoute] = useState(read);

  useEffect(() => {
    const update = () => setRoute(read());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  return route;
}

const COLLAPSE_KEY = 'partnerdex:nav-collapsed';

/**
 * The gate.
 *
 * `Dashboard` is mounted only once we are through it, which is what keeps every
 * data effect inside it honest: none of them has to ask whether it is allowed to
 * run, and signing out unmounts the figures rather than leaving them on screen
 * behind a form.
 */
export default function App() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((next) => {
        if (!cancelled) setSession(next);
      })
      .catch(() => {
        // The session check is the one call that cannot fail closed: a server
        // that is briefly unreachable is not a password prompt. Assume the open
        // configuration and let the real requests report their own trouble.
        if (!cancelled) setSession({ required: false, authenticated: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** A session that lapses mid-read returns the reader to the form. */
  useEffect(() => {
    const signedOut = () => setSession({ required: true, authenticated: false });
    window.addEventListener(SIGNED_OUT_EVENT, signedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, signedOut);
  }, []);

  const handleLogout = useCallback(() => {
    // The cookie is the session, so a failed request leaves it live — say so by
    // staying put rather than showing a login form that a reload would skip.
    logout()
      .then(() => setSession({ required: true, authenticated: false }))
      .catch(() => undefined);
  }, []);

  if (!session) return <div className="skeleton login-wait">Loading…</div>;

  if (session.required && !session.authenticated) {
    return <Login onAuthenticated={() => setSession({ required: true, authenticated: true })} />;
  }

  return <Dashboard onLogout={session.required ? handleLogout : undefined} />;
}

function Dashboard({ onLogout }: { onLogout?: () => void }) {
  const [query, setQuery] = useState<QueryState>({
    period: 'last_12_months',
    appId: '',
    includeUsage: true,
    includeTrials: false,
    rating: 0,
    granularity: 'day',
  });

  const route = useRoute();
  const page = useMemo(() => pageById(route.pageId), [route.pageId]);

  /*
   * A page's declared filter defaults, applied on the way in.
   *
   * During render rather than in an effect, and that is the whole point: an
   * effect runs *after* the new page has mounted and fired its own fetch, so
   * the funnel would ask for twelve months, then immediately ask again for
   * thirty days — two requests, and a first paint of the wrong report. React
   * discards this render and re-runs it before any child sees the state, which
   * is the sanctioned way to adjust state when a prop changes.
   */
  // Null rather than the current page, so a reload straight onto `#/funnel`
  // gets the same defaults a click through to it would.
  const [defaultsFor, setDefaultsFor] = useState<string | null>(null);
  if (defaultsFor !== page.id) {
    setDefaultsFor(page.id);
    if (page.defaults) setQuery((current) => ({ ...current, ...page.defaults }));
  }

  const isCustomers = page.kind === 'customers';
  const isNotifications = page.kind === 'notifications';
  const isReviews = page.kind === 'reviews';
  const isListings = page.kind === 'listings';
  const isBigQuery = page.kind === 'bigquery';
  const isFunnel = page.kind === 'funnel';
  // Only a grid of cards reads the shared window, so only it shows the filters
  // that drive one — and only it has figures that could go stale. Reviews
  // qualifies: it carries cards over that window, with its own list underneath.
  //
  // The funnel is the odd one: it takes the same filters but fetches its own
  // shape, so it shows the controls without joining the overview request.
  const isMetrics = !isCustomers && !isNotifications && !isListings && !isBigQuery;
  const filters = page.filters ?? DEFAULT_FILTERS;

  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem(COLLAPSE_KEY) === '1',
  );
  const toggleNav = useCallback(() => {
    setCollapsed((current) => {
      window.localStorage.setItem(COLLAPSE_KEY, current ? '0' : '1');
      return !current;
    });
  }, []);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [apps, setApps] = useState<AppSummary[]>([]);
  /** Null until asked for; empty means no app has a GA4 dataset configured. */
  const [funnelApps, setFunnelApps] = useState<FunnelApp[] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    fetchApps()
      .then((result) => setApps(result.apps))
      .catch(() => setApps([]));
  }, []);

  /*
   * The funnel picks from its own, shorter list: the apps with a GA4 dataset
   * configured. Re-fetched whenever the page is entered, so connecting a dataset
   * in Settings and coming back finds it here without a reload.
   */
  useEffect(() => {
    if (!isFunnel) return;
    let cancelled = false;
    fetchFunnelApps()
      .then((result) => {
        if (!cancelled) setFunnelApps(result.apps);
      })
      .catch(() => {
        if (!cancelled) setFunnelApps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isFunnel]);

  /*
   * The funnel is always about one app, so an empty or ineligible selection is
   * resolved to a real one rather than left to mean "all". Arriving from another
   * report with an app already chosen keeps it, provided it has a dataset.
   */
  useEffect(() => {
    if (!isFunnel || funnelApps === null || funnelApps.length === 0) return;
    if (!funnelApps.some((app) => app.id === query.appId)) {
      setQuery((current) => ({ ...current, appId: funnelApps[0]!.id }));
    }
  }, [isFunnel, funnelApps, query.appId]);

  /**
   * The server syncs on its own clock, so the dashboard watches for it rather
   * than waiting to be reloaded. Status is the cheap call — counts and a
   * timestamp — so it is the one that polls; the expensive metric call only
   * repeats when the timestamp says there is something new to read.
   */
  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetchStatus()
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch(() => {
          // A failed status poll says nothing about the figures on screen;
          // leave the last known state up and try again on the next tick.
        });
    };
    poll();
    const id = window.setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  /**
   * Bumped when a sync lands that we have not read yet. The first observation
   * only records the watermark: the figures on screen were fetched moments ago
   * and do not need fetching twice.
   */
  const [dataVersion, setDataVersion] = useState(0);
  const seenSyncAt = useRef<string | null>(null);

  useEffect(() => {
    const at = status?.lastSyncAt ?? null;
    if (!at) return;
    if (seenSyncAt.current === null) {
      seenSyncAt.current = at;
      return;
    }
    if (seenSyncAt.current !== at) {
      seenSyncAt.current = at;
      setDataVersion((current) => current + 1);
    }
  }, [status]);

  const wanted = useMemo(() => metricsFor(page), [page]);

  /**
   * Changing page changes which metrics exist in the response, so the old
   * page's data cannot stand in while the new request is in flight — the cards
   * it does not cover would each render as "not available" for a moment.
   * Changing a *filter* keeps the same metrics, so that case deliberately holds
   * the previous figures and updates them in place.
   */
  useEffect(() => {
    setOverview(null);
  }, [page.id]);

  useEffect(() => {
    // The customers page computes nothing over the shared window, and an empty
    // metric list means "everything" to the server — so skip the call outright
    // rather than paying for every metric the dashboard knows about.
    if (wanted.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchOverview(query, wanted)
      .then((result) => {
        if (cancelled) return;
        setOverview(result);
        setError(null);
      })
      .catch((cause: Error) => {
        if (cancelled) return;
        setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `dataVersion` is the refresh trigger: a completed sync re-runs the same
    // request so the figures move in place, without a spinner or a reload.
  }, [query, wanted, dataVersion]);

  const patch = useCallback((changes: Partial<QueryState>) => {
    setQuery((current) => ({ ...current, ...changes }));
  }, []);

  // The overview greets; every other page names itself.
  const heading = page.id === 'overview' ? greeting() : { title: page.title, blurb: page.blurb };

  const anyMetric = overview ? Object.values(overview)[0] : undefined;
  const interval = anyMetric?.timeSeriesInterval === 'day' ? 'Daily' : 'Monthly';
  const hasData = (status?.subscriptions ?? 0) > 0 || (status?.transactions ?? 0) > 0;
  const fixedRange = isFunnel && query.granularity === 'previous_7_days';

  return (
    <div className={collapsed ? 'shell collapsed' : 'shell'}>
      <Nav
        current={page.id}
        collapsed={collapsed}
        onToggle={toggleNav}
        theme={theme}
        onToggleTheme={toggleTheme}
        onLogout={onLogout}
      />

      <main className="main">
        <header className="masthead">
          <div className="masthead-title">
            <h1>{heading.title}</h1>
            <p className="subtitle">{heading.blurb}</p>
          </div>
        </header>

        {/* Which filters a page shows is declared on the page, because they are
            not universally meaningful: trials say nothing about a listing, and
            a star rating says nothing about revenue. */}
        {!isMetrics ? null : (
          <div className="controls">
            {filters.includes('app') ? (
              <div className="control">
                <label htmlFor="app">App</label>
                {/* The funnel offers one app at a time, from the apps that have
                    a GA4 dataset. "All apps" is absent rather than disabled:
                    across apps, one app's visitors sit above several apps'
                    installs and the conversion exceeds 100%. */}
                <select
                  id="app"
                  value={query.appId}
                  disabled={isFunnel && (funnelApps?.length ?? 0) === 0}
                  onChange={(event) => patch({ appId: event.target.value })}
                >
                  {isFunnel ? (
                    funnelApps === null ? (
                      <option value="">Loading…</option>
                    ) : funnelApps.length === 0 ? (
                      <option value="">No app has a dataset yet</option>
                    ) : null
                  ) : (
                    <option value="">All apps in scope</option>
                  )}
                  {(isFunnel ? funnelApps ?? [] : apps).map((app) => (
                    <option key={app.id} value={app.id}>
                      {app.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {filters.includes('granularity') ? (
              <div className="control">
                <label htmlFor="granularity">Granularity</label>
                <select
                  id="granularity"
                  value={query.granularity}
                  onChange={(event) =>
                    patch({ granularity: event.target.value as Granularity })
                  }
                >
                  {GRANULARITIES.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {filters.includes('range') ? (
              <div className="control">
                <label htmlFor="period">Range</label>
                <select
                  id="period"
                  value={query.period}
                  /* A grouped week carries its own span, so the range has
                     nothing left to choose and says so instead of sitting
                     there looking live. */
                  disabled={fixedRange}
                  title={fixedRange ? 'The grouped view covers the last seven days.' : undefined}
                  onChange={(event) => patch({ period: event.target.value })}
                >
                  {PERIODS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {filters.includes('trials') ? (
              <div className="control">
                <label htmlFor="trials">Trials in MRR</label>
                <select
                  id="trials"
                  value={String(query.includeTrials)}
                  onChange={(event) => patch({ includeTrials: event.target.value === 'true' })}
                >
                  <option value="false">Excluded</option>
                  <option value="true">Included</option>
                </select>
              </div>
            ) : null}

            {filters.includes('rating') ? (
              <div className="control">
                <label htmlFor="rating">Rating</label>
                <select
                  id="rating"
                  value={String(query.rating)}
                  onChange={(event) => patch({ rating: Number(event.target.value) })}
                >
                  <option value="0">Any rating</option>
                  {[5, 4, 3, 2, 1].map((value) => (
                    <option key={value} value={value}>
                      {value} star{value === 1 ? '' : 's'}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {/* Granularity is derived, not chosen, so it is reported rather than
              offered: daily up to 90 days, monthly beyond. */}
            {/* <p className="control-note">{interval} buckets</p> */}
          </div>
        )}

        {error && isMetrics ? (
          <div className="notice error">
            <h2>Could not load metrics</h2>
            <p>{error}</p>
          </div>
        ) : null}

        {/* Notifications is configuration, not a report: it is worth setting up
            before the first sync lands, so an empty store is not a reason to
            replace the page with a "no data yet" notice. */}
        {/* Reviews come from the listing, not the Partner API, so a store with
            no transactions is not a reason to tell that page it has no data —
            it may have hundreds of reviews and says so itself when it does not. */}
        {/* BigQuery is configuration, like notifications. The funnel says for
            itself which of its steps it can measure, and an install with no
            Partner API history at all still has a listing worth counting. */}
        {!error &&
        !isNotifications &&
        !isListings &&
        !isReviews &&
        !isBigQuery &&
        !isFunnel &&
        status &&
        !hasData ? (
          <div className="notice">
            <h2>No data yet</h2>
            {/* With the loop running this page fills itself in, so the only
                instruction worth giving is "wait". */}
            {status.sync?.enabled ? (
              <p>
                The background sync runs every {status.sync.intervalMinutes} minute(s) and will pull
                your Partner API history into the local store. The first pass backfills from{' '}
                <code>SYNC_START_DATE</code>, so it can take a few minutes on a large account. This
                page updates itself when it lands.
              </p>
            ) : (
              <p>
                Run <code>npm run sync</code> to pull your Partner API history into the local store,
                then reload.
              </p>
            )}
          </div>
        ) : null}

        {isCustomers ? (
          route.param ? (
            <CustomerDetail shopId={route.param} appId={query.appId} />
          ) : (
            <Customers appId={query.appId} />
          )
        ) : null}

        {isNotifications ? <Notifications /> : null}

        {isListings ? <Listings /> : null}

        {isBigQuery ? <BigQuery /> : null}

        {/* Three states, and the middle one is the point: an install with no
            dataset configured anywhere cannot draw this report for any app, and
            says where to fix it rather than showing five empty rows. */}
        {isFunnel ? (
          funnelApps === null ? (
            <div className="skeleton">Loading apps…</div>
          ) : funnelApps.length === 0 ? (
            <div className="notice">
              <h2>No app has a GA4 dataset yet</h2>
              <p>
                The funnel reads one app at a time, from the GA4 property whose measurement id is
                on that app&rsquo;s App Store listing. Add a dataset for at least one app under{' '}
                <a href="#/bigquery">Settings → BigQuery</a> and it will appear in the picker
                above.
              </p>
            </div>
          ) : query.appId ? (
            <Funnel
              appId={query.appId}
              period={query.period}
              granularity={query.granularity}
              key={dataVersion}
            />
          ) : null
        ) : null}

        {/* Directly under the filters, because an unattributed review is a hole
            in every figure below it — the charts count it, no customer owns it. */}
        {isReviews ? <UnmatchedReviews appId={query.appId} /> : null}

        {/* The funnel fetches its own shape and shows its own skeleton; it has
            no cards in the overview response to be waiting on. */}
        {isMetrics && !isFunnel && loading && !overview ? (
          <div className="skeleton">Loading metrics…</div>
        ) : null}

        {isMetrics && overview ? (
          <div className="card-grid">
            {page.cards.map((card) => (
              <MetricCard
                key={`${page.id}:${card.metric}`}
                spec={card}
                metric={overview[card.metric]}
              />
            ))}
          </div>
        ) : null}


        {status?.lastSyncAt ? (
          <p className="footnote">
            Last sync {formatDateTime(status.lastSyncAt)}
            {/* Silence while the loop is healthy. A failing sync would
                otherwise read as nothing more than a timestamp going quietly
                out of date. */}
            {status.sync?.consecutiveFailures > 0 ? (
              <span className="footnote-warn">
                {' '}
                · last attempt failed{status.sync.lastError ? `: ${status.sync.lastError}` : ''}
              </span>
            ) : null}
          </p>
        ) : null}
      </main>
    </div>
  );
}
