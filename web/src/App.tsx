import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  fetchApps,
  fetchFunnelApps,
  fetchOrganizations,
  fetchSession,
  fetchStatus,
  logout,
  SIGNED_OUT_EVENT,
  type AppSummary,
  type FunnelApp,
  type Organization,
  type Granularity,
  type QueryState,
  type Session,
  type Status,
  type SyncStatus,
} from './api';
import { useOverviewCards } from './useOverview';
import { formatDateTime } from './format';
import { Login } from './components/Login';
import { MetricCard } from './components/MetricCard';
import { Nav } from './components/Nav';
import { DEFAULT_FILTERS, metricsFor, pageById } from './pages';

/*
 * Page bodies arrive in their own chunks.
 *
 * The shell, the navigation and the metric grid are what a reader lands on, and
 * they are the only things worth downloading before the first paint. Everything
 * below is a page they may never open — the merchant list, the four settings
 * screens, the funnel and the whole affiliate section — and each was previously
 * in the one bundle every visit paid for.
 *
 * The `.then` adapters are there because these are named exports and `lazy`
 * wants a default one. Written out rather than routed through a helper: the
 * one-line form keeps each component's props inferred, which a generic wrapper
 * loses.
 */
const Customers = lazy(() =>
  import('./components/Customers').then((m) => ({ default: m.Customers })),
);
const CustomerDetail = lazy(() =>
  import('./components/CustomerDetail').then((m) => ({ default: m.CustomerDetail })),
);
const Listings = lazy(() => import('./components/Listings').then((m) => ({ default: m.Listings })));
const BigQuery = lazy(() => import('./components/BigQuery').then((m) => ({ default: m.BigQuery })));
const Organizations = lazy(() =>
  import('./components/Organizations').then((m) => ({ default: m.Organizations })),
);
const Funnel = lazy(() => import('./components/Funnel').then((m) => ({ default: m.Funnel })));
const Notifications = lazy(() =>
  import('./components/Notifications').then((m) => ({ default: m.Notifications })),
);
const UnmatchedReviews = lazy(() =>
  import('./components/Reviews').then((m) => ({ default: m.UnmatchedReviews })),
);
/* ------------------------------------------------------------ affiliates */
/* -------------------------------------------------------- end affiliates */

/**
 * One boundary per page body rather than one around the whole main column: the
 * reviews page carries a card grid *and* a list, and the cards should not wait
 * on the list's chunk to arrive.
 */
function Chunk({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="skeleton">Loading…</div>}>{children}</Suspense>;
}

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
/**
 * One phrase for what the sync is doing, for the footer.
 *
 * The elapsed time is the point of it. "Syncing" on its own is what the footer
 * said before, and it says the same thing at three seconds and at three hours.
 */
function describeSyncPhase(sync: SyncStatus): string {
  if (!sync.phase) return 'syncing';
  const where = sync.phaseOrg ? `${sync.phase} (${sync.phaseOrg})` : sync.phase;
  const started = sync.phaseStartedAt ? Date.parse(sync.phaseStartedAt) : NaN;
  if (!Number.isFinite(started)) return `syncing: ${where}`;
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  const elapsed = seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
  return `syncing: ${where}, ${elapsed}`;
}

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

function ThemeToggle({ theme, onToggle }: { theme: 'dark' | 'light'; onToggle: () => void }) {
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={label}
      title={label}
    >
      {/* The icon shows the theme you would move to, not the one you are in. */}
      <svg viewBox="0 0 22 22" aria-hidden="true" focusable="false">
        {theme === 'dark' ? (
          <>
            <circle cx="11" cy="11" r="4" fill="none" strokeWidth="1.7" />
            <path
              d="M11 2v2M11 18v2M2 11h2M18 11h2M4.6 4.6l1.4 1.4M16 16l1.4 1.4M17.4 4.6L16 6M6 16l-1.4 1.4"
              fill="none"
              strokeWidth="1.7"
            />
          </>
        ) : (
          <path
            d="M18 13.4A7.5 7.5 0 0 1 8.6 4a7.5 7.5 0 1 0 9.4 9.4z"
            fill="none"
            strokeWidth="1.7"
          />
        )}
      </svg>
    </button>
  );
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
    // Empty is every organization, which is what every figure meant before this
    // selector existed and what it still means for anyone who never touches it.
    orgId: '',
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
    const defaults = page.defaults;
    if (defaults) {
      setQuery((current) => {
        const next = { ...current, ...defaults };
        // Returning the same object when nothing actually changed. The query is
        // the identity every metric request is keyed on, so a spread that
        // rewrote every field to the value it already held would re-issue the
        // whole grid on entering the page for no change in the question.
        const changed = (Object.keys(defaults) as Array<keyof typeof defaults>).some(
          (key) => current[key] !== next[key],
        );
        return changed ? next : current;
      });
    }
  }

  const isCustomers = page.kind === 'customers';
  const isNotifications = page.kind === 'notifications';
  const isReviews = page.kind === 'reviews';
  const isListings = page.kind === 'listings';
  const isBigQuery = page.kind === 'bigquery';
  const isOrganizations = page.kind === 'organizations';
  const isFunnel = page.kind === 'funnel';
  // Only a grid of cards reads the shared window, so only it shows the filters
  // that drive one — and only it has figures that could go stale. Reviews
  // qualifies: it carries cards over that window, with its own list underneath.
  //
  // The funnel is the odd one: it takes the same filters but fetches its own
  // shape, so it shows the controls without joining the overview request.
  const isMetrics = !isCustomers && !isNotifications && !isListings && !isBigQuery && !isOrganizations;
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

  const [apps, setApps] = useState<AppSummary[]>([]);
  /**
   * Every organization, for the selector. Null until asked for.
   *
   * Fetched once per session and only when a page that could show the selector
   * is open — the same bargain the app list makes. One organization means the
   * control is not rendered at all, so an instance that has never used this
   * feature has an unchanged filter row.
   */
  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  /** Null until asked for; empty means no app has a GA4 dataset configured. */
  const [funnelApps, setFunnelApps] = useState<FunnelApp[] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [theme, toggleTheme] = useTheme();

  /*
   * The app list fills one picker, and half the dashboard does not show it —
   * the settings screens and the whole affiliate section take none of the
   * shared filters, and the funnel picks from its own shorter list below. So
   * the request waits until a page that shows the picker is open, and the ref
   * keeps it to once per session rather than once per visit.
   */
  const needsApps = isMetrics && filters.includes('app') && !isFunnel;

  /*
   * Re-fetched when the organization changes, not once per session: the picker
   * offers the apps of the selected organization, and an app list left over from
   * "all organizations" would offer apps the current scope would then 403 on.
   */
  useEffect(() => {
    if (!needsApps) return;
    let cancelled = false;
    fetchApps(query.orgId)
      .then((result) => {
        if (!cancelled) setApps(result.apps);
      })
      .catch(() => {
        if (!cancelled) setApps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [needsApps, query.orgId]);

  const askedForOrgs = useRef(false);

  useEffect(() => {
    if (!isMetrics || askedForOrgs.current) return;
    askedForOrgs.current = true;
    fetchOrganizations()
      .then((result) => setOrgs(result.organizations))
      .catch(() => setOrgs([]));
  }, [isMetrics]);

  /*
   * An app selected under one organization is not necessarily in the next one.
   * Cleared rather than carried, because carrying it asks the server for an app
   * outside the scope and gets a 403 across the whole grid.
   */
  useEffect(() => {
    if (!needsApps || !query.appId) return;
    if (apps.length > 0 && !apps.some((app) => app.id === query.appId)) {
      setQuery((current) => ({ ...current, appId: '' }));
    }
  }, [apps, needsApps, query.appId]);

  /*
   * The funnel picks from its own, shorter list: the apps with a GA4 dataset
   * configured. Re-fetched whenever the page is entered, so connecting a dataset
   * in Settings and coming back finds it here without a reload.
   */
  useEffect(() => {
    if (!isFunnel) return;
    let cancelled = false;
    fetchFunnelApps(query.orgId)
      .then((result) => {
        if (!cancelled) setFunnelApps(result.apps);
      })
      .catch(() => {
        if (!cancelled) setFunnelApps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isFunnel, query.orgId]);

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
      // Nobody is reading a background tab, and a sync that lands while it is
      // hidden is picked up by the poll on the way back. A dashboard left open
      // overnight should not be asking anything of the server.
      if (document.hidden) return;
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
    // Coming back to the tab reads the state now rather than up to a minute
    // later, which is what makes skipping the hidden ticks free.
    document.addEventListener('visibilitychange', poll);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', poll);
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

  /*
   * One request per card rather than one per page.
   *
   * Changing page changes which cards exist, so the old page's figures cannot
   * stand in while the new requests are in flight — hence the page id as the
   * reset key. Changing a *filter* keeps the same cards, so that case
   * deliberately holds the previous figures and replaces each in place as its
   * own request lands. The customers and settings pages compute nothing over
   * the shared window and ask for nothing: an empty metric list means
   * "everything" to the server, so the call is skipped rather than made.
   */
  const {
    cards: cardStates,
    loading,
    outage,
    retry,
  } = useOverviewCards(query, wanted, page.id, dataVersion);

  const patch = useCallback((changes: Partial<QueryState>) => {
    setQuery((current) => ({ ...current, ...changes }));
  }, []);

  // The overview greets; every other page names itself.
  const heading = page.id === 'overview' ? greeting() : { title: page.title, blurb: page.blurb };

  const hasData = status?.hasData === true;
  const fixedRange = isFunnel && query.granularity === 'previous_7_days';

  return (
    <div className={collapsed ? 'shell collapsed' : 'shell'}>
      <Nav current={page.id} collapsed={collapsed} onToggle={toggleNav} onLogout={onLogout} />

      <main className="main">
        <header className="masthead">
          <div>
            <h1>{heading.title}</h1>
            <p className="subtitle">{heading.blurb}</p>
          </div>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </header>

        {/* Which filters a page shows is declared on the page, because they are
            not universally meaningful: trials say nothing about a listing, and
            a star rating says nothing about revenue. */}
        {!isMetrics ? null : (
          <div className="controls">
            {/* Absent, not disabled, on an instance with one organization: a
                control with a single option is a control that only takes up
                room and invites a click that changes nothing. */}
            {filters.includes('org') && (orgs?.length ?? 0) > 1 ? (
              <div className="control">
                <label htmlFor="org">Organization</label>
                <select
                  id="org"
                  value={query.orgId}
                  onChange={(event) => patch({ orgId: event.target.value })}
                >
                  <option value="">All organizations</option>
                  {(orgs ?? []).map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

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

        {/* Only when *every* card failed, which is the shape a server that is
            down or a session that lapsed takes. A single card failing is that
            card's business and is reported inside it, because the rest of the
            page is still worth reading. */}
        {outage && isMetrics ? (
          <div className="notice error">
            <h2>Could not load metrics</h2>
            <p>{outage}</p>
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
        {/* The affiliate pages read their own source tables, which arrive from
            an import rather than from the Partner API sync — so an account with
            no transactions yet still has hundreds of affiliates worth showing. */}
        {!outage &&
        !isNotifications &&
        !isListings &&
        !isReviews &&
        !isBigQuery &&
        !isOrganizations &&
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
          <Chunk>
            {route.param ? (
              <CustomerDetail shopId={route.param} appId={query.appId} orgId={query.orgId} />
            ) : (
              <Customers appId={query.appId} orgId={query.orgId} />
            )}
          </Chunk>
        ) : null}

        {isNotifications ? (
          <Chunk>
            <Notifications />
          </Chunk>
        ) : null}

        {isListings ? (
          <Chunk>
            <Listings />
          </Chunk>
        ) : null}

        {isBigQuery ? (
          <Chunk>
            <BigQuery />
          </Chunk>
        ) : null}

        {isOrganizations ? (
          <Chunk>
            <Organizations />
          </Chunk>
        ) : null}

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
          ) : /* Only once the selection is one of the apps on this list. An app
                 carried over from another report is corrected by the effect
                 above, and rendering the report against it in the meantime
                 fetches a funnel for an app the page will never show. */
          funnelApps.some((app) => app.id === query.appId) ? (
            <Chunk>
              <Funnel
                appId={query.appId}
                orgId={query.orgId}
                period={query.period}
                granularity={query.granularity}
                key={dataVersion}
              />
            </Chunk>
          ) : null
        ) : null}

        {/* Directly under the filters, because an unattributed review is a hole
            in every figure below it — the charts count it, no customer owns it. */}
        {isReviews ? (
          <Chunk>
            <UnmatchedReviews appId={query.appId} orgId={query.orgId} />
          </Chunk>
        ) : null}

        {/* No page-wide "Loading metrics…" any more: the grid is drawn from the
            first frame and each card carries its own state, so a fast figure is
            on screen while a slow one is still being computed. */}
        {isMetrics && !isFunnel && page.cards.length > 0 ? (
          <div className="card-grid" aria-busy={loading ? true : undefined}>
            {page.cards.map((card) => (
              <MetricCard
                key={`${page.id}:${card.metric}`}
                spec={card}
                state={cardStates[card.metric]}
                onRetry={retry}
              />
            ))}
          </div>
        ) : null}


        {status?.lastSyncAt ? (
          <p className="footnote">
            Last sync {formatDateTime(status.lastSyncAt)}
            {/* What the sync is doing right now, while it is doing it. A pass
                that takes minutes used to be indistinguishable here from one
                that had wedged an hour ago: both showed a timestamp going
                quietly out of date. */}
            {status.sync?.running ? <> · {describeSyncPhase(status.sync)}</> : null}
            {/* Silence while the loop is healthy. A failing sync would
                otherwise read as nothing more than a timestamp going quietly
                out of date. */}
            {status.sync?.consecutiveFailures > 0 ? (
              <span className="footnote-warn">
                {' '}
                · last attempt failed
                {status.sync.lastErrorPhase
                  ? ` in ${status.sync.lastErrorPhase}${
                      status.sync.lastErrorOrg ? `/${status.sync.lastErrorOrg}` : ''
                    }`
                  : ''}
                {status.sync.lastError ? `: ${status.sync.lastError}` : ''}
              </span>
            ) : null}
          </p>
        ) : null}
      </main>
    </div>
  );
}
