import { useEffect, useState, type FormEvent } from 'react';
import { fetchSignupOffer, submitSignup, type OpenProgram } from './api';
import { formatRate } from './terms';
import { Logo } from '../components/Logo';

/**
 * The application form — the only page in this product a stranger is invited to
 * open, and the only one that writes to the ledger without a session.
 *
 * Two things about it are worth stating, because both look like copy decisions
 * and are actually correctness ones.
 *
 * **The approval difference is shown before the form is submitted, not after.**
 * A program that requires approval says so on its checkbox, and the confirmation
 * repeats what happens next. Stoq applicants become pending and get no referral
 * link until an admin approves them; if the first they hear of that is a portal
 * with nothing in it, they will assume the link is broken and either promote
 * nothing or ask support. `requiresApproval` is read from the server's program
 * row, so a third program with different rules needs no change here.
 *
 * **The confirmation says the same sentence to everybody.** The server answers
 * identically whether or not the address is already an affiliate, and this page
 * must not undo that by rendering two different outcomes. There is nothing in
 * the response to branch on, deliberately.
 */
export function Signup({ onDone }: { onDone: () => void }) {
  const [programs, setPrograms] = useState<OpenProgram[] | null>(null);
  const [termsUrl, setTermsUrl] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchSignupOffer()
      .then((offer) => {
        if (cancelled) return;
        setPrograms(offer.programs);
        setTermsUrl(offer.termsUrl);
        // Preselect when there is only one thing to choose. With two programs
        // the choice is real and is left to the applicant.
        if (offer.programs.length === 1) setChosen([offer.programs[0]!.id]);
      })
      .catch(() => {
        if (!cancelled) setPrograms([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = (id: string) => {
    setChosen((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  };

  // The terms box only gates the form when there is a document behind it. None
  // is configured today — see `AFFILIATE_TERMS_URL` — and demanding agreement to
  // a link that does not exist would be a checkbox that means nothing.
  const termsSatisfied = !termsUrl || accepted;
  const ready = name.trim() !== '' && email.trim() !== '' && chosen.length > 0 && termsSatisfied;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !ready) return;

    setBusy(true);
    setError(null);
    submitSignup({ name, email, programIds: chosen, acceptedTerms: accepted })
      .then((result) => setDone(result.message))
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  if (done) {
    const needsApproval = (programs ?? []).filter(
      (program) => chosen.includes(program.id) && program.requiresApproval,
    );

    return (
      <div className="login-page">
        <div className="login-card">
          <div className="login-identity">
            <Logo />
            <h1 className="login-brand">Application received</h1>
          </div>
          <p className="login-blurb">{done}</p>

          {needsApproval.length > 0 ? (
            <p className="portal-hint" role="status">
              {needsApproval.map((program) => program.name).join(' and ')}{' '}
              {needsApproval.length === 1 ? 'needs' : 'need'} approval before you can start
              referring. You will not have a referral link for{' '}
              {needsApproval.length === 1 ? 'it' : 'them'} until that happens, and installs before
              then cannot be credited to you.
            </p>
          ) : null}

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
          <h1 className="login-brand">Become an affiliate</h1>
        </div>
        <p className="login-blurb">
          Refer merchants to our apps and earn a share of what they pay, for as long as they keep
          paying.
        </p>

        <div className="control">
          <label htmlFor="signup-name">Your name</label>
          <input
            id="signup-name"
            type="text"
            value={name}
            autoFocus
            maxLength={120}
            autoComplete="name"
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
        </div>

        <div className="control portal-field">
          <label htmlFor="signup-email">Email</label>
          <input
            id="signup-email"
            type="email"
            value={email}
            maxLength={254}
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
          />
        </div>

        <fieldset className="signup-programs">
          <legend>Which programs do you want to join?</legend>

          {programs === null ? <p className="portal-hint">Loading programs…</p> : null}
          {programs !== null && programs.length === 0 ? (
            <p className="portal-hint" role="alert">
              No programs are open for applications right now.
            </p>
          ) : null}

          {(programs ?? []).map((program) => (
            <label className="signup-program" key={program.id}>
              <input
                type="checkbox"
                checked={chosen.includes(program.id)}
                onChange={() => toggle(program.id)}
                disabled={busy}
              />
              <span>
                <strong>{program.name}</strong>
                <span className="row-hint">
                  {formatRate(program.commissionRate)} of gross,{' '}
                  {program.durationMonths
                    ? `for ${program.durationMonths} months from your first commission`
                    : 'with no cut-off'}
                  {/* Said on the checkbox, before anything is submitted. An
                      applicant who only learns this from an empty portal
                      concludes the link is broken. */}
                  {program.requiresApproval ? ' — applications are reviewed before approval' : ''}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {termsUrl ? (
          <label className="login-remember">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
              disabled={busy}
            />
            {/*
              The URL comes from the server's configuration, never from a request
              parameter, and the server refuses anything that is not an http(s)
              URL at startup — so this anchor cannot be pointed at a script.
            */}
            <span>
              I accept the{' '}
              <a href={termsUrl} target="_blank" rel="noreferrer noopener">
                affiliate terms
              </a>
            </span>
          </label>
        ) : null}

        <button type="submit" className="primary login-submit" disabled={busy || !ready}>
          {busy ? 'Sending…' : 'Apply'}
        </button>

        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}

        <p className="portal-hint">
          Already an affiliate?{' '}
          <button type="button" className="link-button" onClick={onDone} disabled={busy}>
            Sign in
          </button>
        </p>
      </form>
    </div>
  );
}
