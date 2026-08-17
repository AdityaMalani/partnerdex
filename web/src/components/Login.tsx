import { useState, type FormEvent } from 'react';
import { login } from '../api';
import { Logo } from './Logo';

/**
 * The whole dashboard behind one password.
 *
 * It renders in place of the shell rather than over it, so there is never a
 * frame where figures are painted underneath a modal — the reader has not been
 * sent any yet.
 */
export function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !password) return;

    setBusy(true);
    setError(null);
    login(password, remember)
      .then(() => {
        setPassword('');
        onAuthenticated();
      })
      .catch((cause: Error) => {
        setError(cause.message);
        setBusy(false);
      });
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-identity">
          <Logo />
          <h1 className="login-brand">PartnerDex</h1>
        </div>
        <p className="login-blurb">Enter the dashboard password to continue.</p>

        <div className="control">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
        </div>

        <label className="check login-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            disabled={busy}
          />
          <span>Remember me</span>
        </label>
        {/* Said plainly, because "remember me" on a shared machine is a
            decision and the reader is the only one who can make it. */}
        <p className="login-note">Stays signed in on this browser for 30 days.</p>

        <button type="submit" className="primary login-submit" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}
