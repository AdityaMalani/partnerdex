import { useState, type FormEvent } from 'react';
import { setPassword } from './api';
import { Logo } from '../components/Logo';

const MIN_LENGTH = 10;

/**
 * Redeeming a set-password link.
 *
 * The token arrives in the URL *fragment* — `#/set-password/<token>` — which is
 * the reason this is a route rather than a query parameter. A fragment is never
 * sent to the server, so the token stays out of access logs, out of the referrer
 * header on any link the reader clicks next, and out of anything a proxy in
 * between writes down.
 *
 * Confirmation field included on purpose: a mistyped password on a set-password
 * form is not recoverable by trying again, it is recoverable by requesting a
 * whole new link, and the token that got here has already been spent.
 */
export function SetPassword({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= MIN_LENGTH && confirm === password;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !ready) return;

    setBusy(true);
    setError(null);
    setPassword(token, password)
      .then(() => setDone(true))
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  if (done) {
    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-identity">
            <Logo />
            <h1 className="login-brand">Password set</h1>
          </div>
          <p className="login-blurb">You can sign in with it now.</p>
          {/* Sign-in is not done for the reader here: typing the new password
              once more is the cheapest possible check that it is the one their
              password manager actually saved. */}
          <button type="button" className="primary login-submit" onClick={onDone}>
            Go to sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-identity">
          <Logo />
          <h1 className="login-brand">Choose a password</h1>
        </div>
        <p className="login-blurb">
          This link works once and expires 24 hours after it was sent.
        </p>

        <div className="control">
          <label htmlFor="password">New password</label>
          <input
            id="password"
            type="password"
            value={password}
            autoFocus
            autoComplete="new-password"
            onChange={(event) => setValue(event.target.value)}
            disabled={busy}
          />
        </div>
        <p className="login-note portal-note">At least {MIN_LENGTH} characters.</p>

        <div className="control portal-field">
          <label htmlFor="confirm">Confirm password</label>
          <input
            id="confirm"
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(event) => setConfirm(event.target.value)}
            disabled={busy}
          />
        </div>

        <button type="submit" className="primary login-submit" disabled={busy || !ready}>
          {busy ? 'Saving…' : 'Set password'}
        </button>

        {error || tooShort || mismatch ? (
          <p className="login-error" role="alert">
            {error ??
              (tooShort
                ? `Use at least ${MIN_LENGTH} characters.`
                : 'The two passwords do not match.')}
          </p>
        ) : null}
      </form>
    </div>
  );
}
