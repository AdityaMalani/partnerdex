import { useState, type FormEvent } from 'react';
import { login, requestReset } from './api';
import { Logo } from '../components/Logo';

/**
 * The affiliate sign-in, and the way in for the hundreds of affiliates who have
 * never had a password here.
 *
 * Both live on one card rather than two screens, because for the whole first
 * month of this portal's life the *normal* path is "I have no password yet" —
 * every account was imported. A separate forgotten-password page would put the
 * common case one click behind the rare one.
 */
export function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !email || !password) return;

    setBusy(true);
    setError(null);
    login(email, password, remember)
      .then(onAuthenticated)
      .catch((cause: Error) => {
        setError(cause.message);
        setBusy(false);
      });
  };

  const sendLink = () => {
    if (busy || !email) {
      setError('Enter your email address first.');
      return;
    }
    setBusy(true);
    setError(null);
    requestReset(email)
      .then(() => setSent(true))
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-identity">
          <Logo />
          <h1 className="login-brand">Affiliate portal</h1>
        </div>
        <p className="login-blurb">Sign in to see your referrals and what they have earned.</p>

        <div className="control">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            autoFocus
            autoComplete="username"
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
          />
        </div>

        <div className="control portal-field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
        </div>

        <label className="login-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            disabled={busy}
          />
          <span>Remember me</span>
        </label>
        <p className="login-note">Stays signed in on this browser for 30 days.</p>

        <button type="submit" className="primary login-submit" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}

        {/*
          Said the same way whether or not the address is one of ours — the
          server answers identically too, so this sentence is not a hint about
          who is an affiliate and who is not.
        */}
        {sent ? (
          <p className="portal-hint" role="status">
            If that address is on our affiliate list, a set-password link is on its way. Links
            expire after 24 hours.
          </p>
        ) : (
          <p className="portal-hint">
            No password yet, or forgotten it?{' '}
            <button type="button" className="link-button" onClick={sendLink} disabled={busy}>
              Send me a set-password link
            </button>
          </p>
        )}

        {/*
          The front door for the next new partner. Below the sign-in rather than
          beside it: for the first month of this portal's life almost everyone
          arriving is one of the many who already have an account, so applying is
          the rarer case and gets the lower position — but it exists, which it
          did not before, and a program with no way in can only shrink.
        */}
        <p className="portal-hint">
          Not an affiliate yet?{' '}
          <a className="link-button" href="#/signup">
            Apply to join
          </a>
        </p>
      </form>
    </div>
  );
}
