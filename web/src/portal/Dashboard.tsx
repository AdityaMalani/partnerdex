import { useEffect, useState } from 'react';
import {
  fetchClaims,
  fetchEarnings,
  fetchMe,
  fetchPayouts,
  fetchPrograms,
  fetchReferrals,
  type ClaimPage,
  type Earnings,
  type Me,
  type PayoutPage,
  type Program,
  type Referral,
} from './api';
import { Logo } from '../components/Logo';
import { Claims } from './Claims';
import { Overview } from './Overview';
import { Payouts } from './Payouts';
import { Programs } from './Programs';
import { Referrals } from './Referrals';
import { parseRoute, ROUTES, ROUTE_LABELS, type PortalRoute } from './routes';

/**
 * The portal shell: identity, four tabs, one pass of requests.
 *
 * Everything is fetched once on mount rather than per tab. The whole payload for
 * a busy affiliate is a few hundred rows, switching tabs is the most common
 * thing anyone does here, and a spinner per tab would cost more than the bytes
 * saved. It also means the tabs are pure rendering — nothing in this app fetches
 * in response to a route, so there is no route that can be made to fetch
 * something it should not.
 *
 * No affiliate identifier appears anywhere in this file, in the routes, or in
 * any request. Scope comes from the session cookie, server-side, every time.
 */

function useRoute(): [PortalRoute, (next: PortalRoute) => void] {
  const [route, setRoute] = useState<PortalRoute>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const update = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  return [
    route,
    (next: PortalRoute) => {
      // Assigning the hash fires `hashchange`, which sets the state; setting it
      // here too would be a second render for the same fact.
      window.location.hash = `#/${next}`;
    },
  ];
}

export function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [earnings, setEarnings] = useState<Earnings | null>(null);
  const [referrals, setReferrals] = useState<Referral[] | null>(null);
  const [programs, setPrograms] = useState<Program[] | null>(null);
  const [payouts, setPayouts] = useState<PayoutPage | null>(null);
  const [claims, setClaims] = useState<ClaimPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, navigate] = useRoute();

  useEffect(() => {
    let cancelled = false;
    // `fetchPrograms` and `fetchPayouts` resolve even when their endpoints are
    // missing, so only the three routes that have always existed can fail the
    // whole page.
    Promise.all([
      fetchMe(),
      fetchEarnings(),
      fetchReferrals(),
      fetchPrograms(),
      fetchPayouts(),
      fetchClaims(),
    ])
      .then(([meResult, earningsResult, referralResult, programResult, payoutResult, claimResult]) => {
        if (cancelled) return;
        setMe(meResult);
        setEarnings(earningsResult);
        setReferrals(referralResult.referrals);
        setPrograms(programResult);
        setPayouts(payoutResult);
        setClaims(claimResult);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="portal-shell">
        <div className="notice error">
          <h2>Could not load your account</h2>
          <p>{error}</p>
          <p className="portal-hint portal-note">
            Reload the page. If it keeps happening, get in touch and we will look at it.
          </p>
        </div>
      </div>
    );
  }

  if (!me || !earnings || !referrals || !programs || !payouts || !claims) {
    return <div className="skeleton login-wait">Loading…</div>;
  }

  return (
    <div className="portal-shell">
      <header className="portal-head">
        <div className="login-identity">
          <Logo />
          <div>
            {/* An affiliate's own name, from an imported record. Text, always. */}
            <h1 className="portal-title">{me.affiliate.name || 'Affiliate portal'}</h1>
            <p className="subtitle">{me.affiliate.email}</p>
          </div>
        </div>
        <button type="button" className="link-button" onClick={onLogout}>
          Sign out
        </button>
      </header>

      <nav className="portal-tabs" aria-label="Portal sections">
        {ROUTES.map((name) => (
          <button
            type="button"
            key={name}
            className={`portal-tab${route === name ? ' active' : ''}`}
            aria-current={route === name ? 'page' : undefined}
            onClick={() => navigate(name)}
          >
            {ROUTE_LABELS[name]}
          </button>
        ))}
      </nav>

      {/* Stated rather than left to be inferred from a balance that stops
          moving. An affiliate on hold will ask; better they read it here. A
          strip rather than a card: it has to be seen on every tab, and a card
          seen on every tab is a card nobody reads. */}
      {me.affiliate.payoutHold ? (
        <p className="portal-banner">
          <span className="pill pill-churned">Payments on hold</span> Commission is still being
          recorded, but nothing is being paid out. Get in touch and we will sort out what is holding
          it up.
        </p>
      ) : null}

      {route === 'overview' ? (
        <Overview me={me} earnings={earnings} onNavigate={navigate} />
      ) : null}
      {route === 'programs' ? <Programs programs={programs} /> : null}
      {route === 'referrals' ? <Referrals referrals={referrals} /> : null}
      {/* The one tab that writes. Filing re-reads the list rather than
          patching it in place: the server decides what a claim looks like —
          including whether it was a duplicate of one already filed — and a
          locally invented row would be this client guessing at that. */}
      {route === 'claims' ? (
        <Claims
          page={claims}
          programs={programs}
          onFiled={() => {
            fetchClaims().then(setClaims, () => undefined);
          }}
        />
      ) : null}
      {route === 'payouts' ? <Payouts page={payouts} earnings={earnings} /> : null}
    </div>
  );
}
