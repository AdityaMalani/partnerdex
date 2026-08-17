import { useCallback, useEffect, useState } from 'react';
import { fetchSession, logout, SIGNED_OUT_EVENT, type PortalSession } from './api';
import { Dashboard } from './Dashboard';
import { Login } from './Login';
import { SetPassword } from './SetPassword';
import { Signup } from './Signup';

/**
 * The portal shell: three states, and the gate between them.
 *
 * `Dashboard` mounts only once the session check has come back authenticated,
 * which is what keeps every fetch inside it honest — none has to ask whether it
 * is allowed to run, and signing out unmounts the figures rather than leaving
 * one partner's earnings on screen behind a form.
 */

/**
 * The two routes that exist outside a session: `#/set-password/<token>` and
 * `#/signup`.
 *
 * Both are read from the hash for the same reason — the portal is one static
 * bundle served from `/portal`, so there are no server-side paths to route on.
 * Neither carries an identifier that names anybody: the token is a bearer secret
 * the server checks, and signup names nothing at all.
 */
function useUnauthenticatedRoute(): { route: 'set-password' | 'signup' | null; token: string } {
  const read = (): { route: 'set-password' | 'signup' | null; token: string } => {
    const raw = window.location.hash.replace(/^#\/?/, '');
    const [name, token] = raw.split('/');
    if (name === 'set-password' && token) {
      return { route: 'set-password', token: decodeURIComponent(token) };
    }
    if (name === 'signup') return { route: 'signup', token: '' };
    return { route: null, token: '' };
  };
  const [state, setState] = useState(read);

  useEffect(() => {
    const update = () => setState(read());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  return state;
}

export default function PortalApp() {
  const [session, setSession] = useState<PortalSession | null>(null);
  const { route, token } = useUnauthenticatedRoute();

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((next) => {
        if (!cancelled) setSession(next);
      })
      // Unlike the dashboard's, this check fails *closed*. There is no open
      // configuration for the portal — an affiliate is always somebody in
      // particular — so a server that cannot answer means "show the form".
      .catch(() => {
        if (!cancelled) setSession({ authenticated: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const signedOut = () => setSession({ authenticated: false });
    window.addEventListener(SIGNED_OUT_EVENT, signedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, signedOut);
  }, []);

  const handleLogout = useCallback(() => {
    // The cookie is the session, so a failed request leaves it live — stay put
    // rather than showing a form that a reload would skip straight past.
    logout()
      .then(() => setSession({ authenticated: false }))
      .catch(() => undefined);
  }, []);

  // Ahead of the session check, and deliberately: somebody redeeming a link is
  // usually signed out, and the one case where they are not — resetting while
  // signed in — should still land on the form they clicked through to.
  // Ahead of the session check for the same reason as set-password: somebody
  // applying is signed out by definition, and waiting for a session probe that
  // will say "no" only delays the form.
  if (route === 'signup') {
    return (
      <Signup
        onDone={() => {
          window.location.hash = '';
          setSession({ authenticated: false });
        }}
      />
    );
  }

  if (route === 'set-password' && token) {
    return (
      <SetPassword
        token={token}
        onDone={() => {
          // Clears the token out of the address bar so a reload does not present
          // a link that has now been spent.
          window.location.hash = '';
          setSession({ authenticated: false });
        }}
      />
    );
  }

  if (!session) return <div className="skeleton login-wait">Loading…</div>;

  if (!session.authenticated) {
    return <Login onAuthenticated={() => setSession({ authenticated: true })} />;
  }

  return <Dashboard onLogout={handleLogout} />;
}
