/**
 * What each page shows, as data rather than as markup.
 *
 * Keeping the card list declarative is what lets the fetch layer ask the server
 * for exactly the metrics the current page needs, instead of every metric the
 * dashboard knows about. Adding a card to a page is a one-line change here.
 */

export type PlotKind = 'line' | 'bar' | 'area';

export interface CardSpec {
  /** Key into the overview response, and the metric the server computes. */
  metric: string;
  label: string;
  subtitle?: string;
  plot: PlotKind;
  /** Draw the metric's component breakdown instead of its total. */
  breakdown?: boolean;
  /**
   * What the plot is measuring, when that is not neutral. Growth draws green and
   * churn draws red, per the design system; everything else draws in the brand.
   * Ignored on breakdown cards, where the categorical slots identify the series.
   */
  tone?: 'growth' | 'churn';
  /** Metrics where a rise is bad, so the delta colours invert. */
  invertDelta?: boolean;
  /** Let one card take the whole row; still at most three cards across. */
  full?: boolean;
}

export interface PageSpec {
  id: string;
  label: string;
  title: string;
  blurb: string;
  cards: CardSpec[];
  /**
   * Metric pages are a grid of cards over a shared time window. Customers and
   * notifications are different shapes entirely — a searchable population, and
   * a settings form — so they opt out of the window controls rather than
   * showing filters that would not apply to them.
   *
   * Reviews is the one page that is both: cards over the shared window, and a
   * searchable list of the documents behind them.
   */
  kind?:
    | 'metrics'
    | 'customers'
    | 'notifications'
    | 'reviews'
    | 'listings'
    | 'funnel'
    | 'bigquery'
    | 'organizations';
  /**
   * Which shared filters this page shows, in order.
   *
   * Declared rather than assumed because they are not universally meaningful:
   * "Trials in MRR" changes nothing on a page about App Store reviews, and a
   * rating filter changes nothing anywhere else.
   */
  filters?: PageFilter[];
  /**
   * What the shared filters should read when this page is opened.
   *
   * The window is shared across reports so that moving between them keeps the
   * question fixed, but "shared" is not the same as "right everywhere": a year
   * of daily funnel columns is a matrix nobody reads left to right. A page that
   * declares defaults gets them applied on entry, and the reader can still
   * change them afterwards.
   */
  defaults?: Partial<PageDefaults>;
}

export interface PageDefaults {
  period: string;
  granularity: 'day' | 'week' | 'month' | 'previous_7_days';
}

export type PageFilter = 'org' | 'app' | 'range' | 'trials' | 'rating' | 'granularity';

/**
 * What a metric page shows when it has not asked for anything different.
 *
 * The organization comes first because it is the widest of them: it decides
 * which apps the app picker beside it can even offer. It renders as nothing at
 * all on an instance with one organization, which is every instance that has
 * never used this feature.
 */
export const DEFAULT_FILTERS: PageFilter[] = ['org', 'app', 'range', 'trials'];

export interface NavGroup {
  label: string;
  pages: PageSpec[];
}

const OVERVIEW: PageSpec = {
  id: 'overview',
  label: 'Overview',
  title: 'Overview',
  blurb: 'The five figures that say whether the business is working.',
  cards: [
    {
      metric: 'mrr',
      label: 'MRR',
      subtitle: 'Recurring revenue live at each point.',
      plot: 'line',
    },
    {
      metric: 'gross_earnings',
      label: 'Gross earnings',
      subtitle: 'Billed in the period, before revenue share.',
      plot: 'bar',
    },
    {
      metric: 'revenue_churn',
      label: 'Revenue churn',
      subtitle: 'MRR lost against the MRR at the window start.',
      plot: 'line',
      tone: 'churn',
      invertDelta: true,
    },
    {
      metric: 'subscribers',
      label: 'Subscribers',
      subtitle: 'Shop-and-app pairs currently paying.',
      plot: 'line',
    },
    {
      metric: 'on_trial',
      label: 'On trial',
      subtitle: 'Inside the free period at each point.',
      plot: 'line',
    },
  ],
};

const REVENUE: PageSpec = {
  id: 'revenue',
  label: 'Revenue',
  title: 'Revenue',
  blurb: 'What is being earned, how fast it is growing, and what each customer is worth.',
  cards: [
    { metric: 'mrr', label: 'MRR', subtitle: 'Recurring revenue live at each point.', plot: 'line' },
    { metric: 'arr', label: 'ARR', subtitle: 'Run-rate: MRR × 12.', plot: 'line' },
    {
      metric: 'gross_earnings',
      label: 'Gross earnings',
      subtitle: 'Billed in the period, before revenue share.',
      plot: 'bar',
    },
    {
      metric: 'mrr_growth',
      label: 'MRR growth',
      subtitle: 'Change against the bucket before.',
      plot: 'line',
      tone: 'growth',
    },
    {
      metric: 'arpu',
      label: 'ARPU',
      subtitle: 'MRR over the paying population.',
      plot: 'line',
    },
    {
      metric: 'ltv',
      label: 'LTV',
      subtitle: 'ARPU over monthly churn. Directional, not a cohort measure.',
      plot: 'line',
    },
    {
      metric: 'mrr_by_app',
      label: 'MRR contribution by app',
      subtitle: 'Where the recurring revenue comes from.',
      plot: 'area',
      breakdown: true,
      full: true,
    },
  ],
};

const SUBSCRIPTIONS: PageSpec = {
  id: 'subscriptions',
  label: 'Subscriptions',
  title: 'Subscriptions',
  blurb: 'Who is paying, who just started, and who is still deciding.',
  cards: [
    {
      metric: 'subscribers',
      label: 'Active subscribers',
      subtitle: 'Shop-and-app pairs currently paying.',
      plot: 'line',
    },
    {
      metric: 'new_subscriptions',
      label: 'New subscriptions',
      subtitle: 'Started paying in the period, excluding plan changes.',
      plot: 'bar',
      tone: 'growth',
    },
    {
      metric: 'subscription_growth',
      label: 'Subscription growth',
      subtitle: 'Change against the bucket before.',
      plot: 'line',
      tone: 'growth',
    },
    {
      metric: 'on_trial',
      label: 'On trial',
      subtitle: 'Inside the free period at each point.',
      plot: 'line',
    },
    {
      metric: 'trial_conversion_rate',
      label: 'Trial conversion',
      subtitle: 'Share of decided trials that reached a paid charge.',
      plot: 'line',
    },
  ],
};

const CHURN: PageSpec = {
  id: 'churn',
  label: 'Churn',
  title: 'Churn',
  blurb:
    'The same loss measured three ways. Revenue churn runs above the others when the customers leaving are the expensive ones.',
  cards: [
    {
      metric: 'revenue_churn',
      label: 'Revenue churn',
      subtitle: 'MRR lost against the MRR at the window start.',
      plot: 'line',
      tone: 'churn',
      invertDelta: true,
    },
    {
      metric: 'subscription_churn',
      label: 'Subscription churn',
      subtitle: 'Contracts lost against those live at the window start.',
      plot: 'line',
      tone: 'churn',
      invertDelta: true,
    },
    {
      metric: 'logo_churn',
      label: 'Logo churn',
      subtitle: 'Uninstalls net of reinstalls against installs active at the window start.',
      plot: 'line',
      tone: 'churn',
      invertDelta: true,
    },
  ],
};

const CUSTOMERS: PageSpec = {
  id: 'customers',
  label: 'Customers',
  title: 'Customers',
  blurb: 'Every merchant, what they run today, and everything that has happened to them.',
  kind: 'customers',
  cards: [],
};

const REVIEWS: PageSpec = {
  id: 'reviews',
  label: 'Reviews',
  title: 'Reviews',
  blurb:
    'Everything on your App Store listing, and everything that used to be.',
  kind: 'reviews',
  cards: [
    {
      metric: 'reviews_live',
      label: 'Reviews on the listing',
      subtitle: 'Live at each point, removals taken off.',
      plot: 'line',
    },
    {
      metric: 'reviews_average_rating',
      label: 'Average rating',
      subtitle: 'Mean of the reviews live at each point.',
      plot: 'line',
    },
    {
      metric: 'reviews_removed',
      label: 'Removed',
      subtitle: 'Deleted / purged from the listing.',
      plot: 'bar',
      tone: 'churn',
      invertDelta: true,
    },
    {
      metric: 'reviews_posted',
      label: 'New reviews',
      subtitle: 'Posted in the period.',
      plot: 'bar',
      full: true,
    },
  ],
  // Trials have nothing to do with a listing. The rating filter takes the slot
  // and reaches every card, so the whole page can be read one star at a time.
  filters: ['org', 'app', 'range', 'rating'],
};

const FUNNEL: PageSpec = {
  id: 'funnel',
  label: 'Funnel',
  title: 'Funnel',
  blurb:
    'From the listing page to a paying merchant, and where along the way they stop.',
  kind: 'funnel',
  cards: [],
  // No trials toggle: this page is *about* trials as a step, not about whether
  // they count towards revenue. Granularity takes the slot, because the whole
  // report is a matrix and the column width is the reader's main lever.
  filters: ['org', 'app', 'granularity', 'range'],
  // A day-by-day read of the last month: narrow enough that the columns still
  // fit an eye-sweep, long enough that a trial started at the start of it has
  // had time to decide. The twelve months every other report opens on would be
  // 365 columns of five steps.
  defaults: { granularity: 'day', period: 'last_30_days' },
};

const LISTINGS: PageSpec = {
  id: 'listings',
  label: 'App listings',
  title: 'App listings',
  blurb:
    'Which App Store page belongs to which of your apps.',
  kind: 'listings',
  cards: [],
};

const ORGANIZATIONS: PageSpec = {
  id: 'organizations',
  label: 'Organizations',
  title: 'Organizations',
  blurb: 'The Shopify Partner organizations this instance syncs, and how each one is doing.',
  kind: 'organizations',
  cards: [],
};

const NOTIFICATIONS: PageSpec = {
  id: 'notifications',
  label: 'Notifications',
  title: 'Notifications',
  blurb: 'Send customer events to Slack as they happen, instead of noticing them a week later.',
  kind: 'notifications',
  cards: [],
};

const BIGQUERY: PageSpec = {
  id: 'bigquery',
  label: 'BigQuery',
  title: 'BigQuery',
  blurb:
    'The GA4 export behind the funnel.',
  kind: 'bigquery',
  cards: [],
};

export const NAV: NavGroup[] = [
  { label: '', pages: [OVERVIEW, CUSTOMERS] },
  { label: 'Reports', pages: [REVENUE, SUBSCRIPTIONS, CHURN, FUNNEL, REVIEWS] },
  { label: 'Settings', pages: [ORGANIZATIONS, LISTINGS, BIGQUERY, NOTIFICATIONS] },
];

export const PAGES: PageSpec[] = NAV.flatMap((group) => group.pages);

export function pageById(id: string): PageSpec {
  return PAGES.find((page) => page.id === id) ?? OVERVIEW;
}

/** The metric keys one page needs, deduplicated. */
export function metricsFor(page: PageSpec): string[] {
  return [...new Set(page.cards.map((card) => card.metric))];
}
