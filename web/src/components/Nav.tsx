import { Logo } from './Logo';
import { NAV, type PageSpec } from '../pages';

/**
 * The left rail. Collapsing it keeps the labels' meaning in the icons rather
 * than dropping to bare glyphs with no accessible name: every item keeps its
 * title and aria-label, so a collapsed rail is still navigable by screen reader
 * and by hover.
 */

const ICONS: Record<string, string> = {
  // Simple 20x20 stroke paths, drawn from the metric each page leads with.
  overview: 'M3 13h4v5H3zM9 7h4v11H9zM15 10h4v8h-4z',
  revenue: 'M3 15l5-5 4 3 6-7',
  subscriptions: 'M8 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 19a6 6 0 0 1 12 0M16 8h5M18.5 5.5v5',
  churn: 'M3 6l5 5 4-3 6 7M15 15h5v-5',
  customers: 'M9 10a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM2.5 19a6.5 6.5 0 0 1 13 0M16 4.2a3.2 3.2 0 0 1 0 6.2M17.5 13.2A6.5 6.5 0 0 1 21 19',
  notifications: 'M5.5 15.5V10a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14zM9 17.5a2 2 0 0 0 4 0',
  reviews: 'M11 3.2l2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z',
  listings: 'M3.5 6.5h15v11h-15zM3.5 9.5h15M7 13h8M7 15.5h5',
  // A funnel: wide at the listing, narrow at the paying merchant.
  funnel: 'M3 4h16l-6 7v7l-4-2v-5z',
  // Stacked cylinders — the universal read for a warehouse table.
  bigquery:
    'M4.5 6c0-1.1 2.9-2 6.5-2s6.5.9 6.5 2-2.9 2-6.5 2-6.5-.9-6.5-2zM4.5 6v10c0 1.1 2.9 2 6.5 2s6.5-.9 6.5-2V6M4.5 11c0 1.1 2.9 2 6.5 2s6.5-.9 6.5-2',
};

function Icon({ id }: { id: string }) {
  return (
    <svg className="nav-icon" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <path d={ICONS[id] ?? ICONS.overview!} fill="none" strokeWidth="1.7" />
    </svg>
  );
}

const SIGN_OUT_ICON = 'M13 3.5H5.5v15H13M10 11h10m0 0l-3.2-3.2M20 11l-3.2 3.2';

const MOON_ICON = 'M18 13.4A7.5 7.5 0 0 1 8.6 4a7.5 7.5 0 1 0 9.4 9.4z';
const SUN_RAYS =
  'M11 2v2M11 18v2M2 11h2M18 11h2M4.6 4.6l1.4 1.4M16 16l1.4 1.4M17.4 4.6L16 6M6 16l-1.4 1.4';

export function Nav({
  current,
  collapsed,
  onToggle,
  theme,
  onToggleTheme,
  onLogout,
}: {
  current: string;
  collapsed: boolean;
  onToggle: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  /** Absent when no password is set: there is no session to end. */
  onLogout?: () => void;
}) {
  /* The icon and the label both name the theme the click moves *to*, not the
     one you are in — the same convention the control kept when it floated. */
  const themeLabel = theme === 'dark' ? 'Light theme' : 'Dark theme';
  const item = (page: PageSpec) => (
    <li key={page.id}>
      <a
        href={`#/${page.id}`}
        className={page.id === current ? 'nav-link active' : 'nav-link'}
        aria-current={page.id === current ? 'page' : undefined}
        title={collapsed ? page.label : undefined}
      >
        <Icon id={page.id} />
        <span className="nav-label">{page.label}</span>
      </a>
    </li>
  );

  return (
    <nav className={collapsed ? 'nav collapsed' : 'nav'} aria-label="Reports">
      <div className="nav-head">
        {/* The mark survives the collapse; the wordmark beside it does not, so
            a narrow rail still says whose dashboard this is. */}
        <span className="nav-identity" title={collapsed ? 'PartnerDex' : undefined}>
          <Logo />
          <span className="nav-brand">PartnerDex</span>
        </span>
        <button
          type="button"
          className="nav-toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        >
          <svg viewBox="0 0 22 22" aria-hidden="true" focusable="false">
            <path
              d={collapsed ? 'M8 5l6 6-6 6' : 'M14 5l-6 6 6 6'}
              fill="none"
              strokeWidth="1.8"
            />
          </svg>
        </button>
      </div>

      {NAV.map((group, index) => (
        <div className="nav-group" key={group.label || `group-${index}`}>
          {group.label ? <div className="nav-group-label">{group.label}</div> : null}
          <ul>{group.pages.map(item)}</ul>
        </div>
      ))}

      {/* Pinned to the foot of the rail rather than sitting in a group: neither
          of these is a place you can navigate to. The theme sits above sign-out
          because sign-out is the one item here whose click cannot be undone by
          clicking something else, so it stays last. */}
      <div className="nav-foot">
        <button
          type="button"
          className="nav-link nav-action"
          onClick={onToggleTheme}
          title={collapsed ? themeLabel : undefined}
          aria-label={`Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          <svg className="nav-icon" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
            {theme === 'dark' ? (
              <>
                <circle cx="11" cy="11" r="4" fill="none" strokeWidth="1.7" />
                <path d={SUN_RAYS} fill="none" strokeWidth="1.7" />
              </>
            ) : (
              <path d={MOON_ICON} fill="none" strokeWidth="1.7" />
            )}
          </svg>
          <span className="nav-label">{themeLabel}</span>
        </button>

        {onLogout ? (
          <button
            type="button"
            className="nav-link nav-action"
            onClick={onLogout}
            title={collapsed ? 'Sign out' : undefined}
            aria-label="Sign out"
          >
            <svg className="nav-icon" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
              <path d={SIGN_OUT_ICON} fill="none" strokeWidth="1.7" />
            </svg>
            <span className="nav-label">Sign out</span>
          </button>
        ) : null}
      </div>
    </nav>
  );
}
