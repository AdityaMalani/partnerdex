import { useEffect, useState } from 'react';
import {
  createAffiliate,
  fetchAffiliatePrograms,
  type AffiliateProgram,
  type CreatedAffiliate,
} from '../api';
import { referralLink } from './AffiliateData';

/**
 * Adding an affiliate.
 *
 * The other half of what "half baked" meant. There was no way to do this at
 * all: an affiliate arrived through the Mantle import or through public
 * self-signup, and an operator who had agreed terms with somebody over email
 * had to write SQL. Which makes the first step of running a programme a thing
 * you cannot do from the product.
 *
 * Three fields, because three is what it takes: a name, an address, and which
 * programme. The programme is on this form rather than a second screen because
 * an affiliate with no membership has no handle, and an affiliate with no
 * handle has no link — so splitting it leaves the obvious first path ending in
 * a record that cannot earn and no sign of what is missing.
 *
 * ## The link is shown once, and it is a credential
 *
 * `setPasswordUrl` is a 24-hour account-takeover token. It is in the response
 * because when no mail relay is configured the operator is the only one who can
 * deliver it. It is rendered once, never stored by this component beyond the
 * render, and the copy beside it says what it is — an operator who thinks it is
 * a profile link will paste it somewhere durable.
 */

export function AffiliateInvite({ onCreated }: { onCreated: () => void }) {
  const [programs, setPrograms] = useState<AffiliateProgram[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [programId, setProgramId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedAffiliate | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAffiliatePrograms()
      .then((result) => {
        if (cancelled) return;
        const open = result.programs.filter((program) => program.status === 'active');
        setPrograms(open);
        // Preselected when there is exactly one, which is the common shape and
        // the one where a required dropdown is pure friction. With two or more
        // there is a real choice and guessing it would enrol somebody in the
        // wrong programme — a wrong rate, silently.
        if (open.length === 1) setProgramId(open[0]!.id);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await createAffiliate({
        name,
        email,
        ...(programId ? { programId } : {}),
      });
      setCreated(result);
      setName('');
      setEmail('');
      onCreated();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <section className="card full">
        <div className="card-label">{created.affiliate.name} added</div>
        <div className="stat-row">
          <div className="stat">
            <span className="stat-label">Handle</span>
            <span className="stat-value">
              <code>{created.membership?.handle ?? '—'}</code>
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">Status</span>
            <span className="stat-value">{created.membership ? 'Enrolled' : 'No programme'}</span>
          </div>
        </div>

        {created.membership ? (
          <p className="channel-note">
            Referral link: <code>{referralLink(created.membership.handle)}</code>
          </p>
        ) : null}

        {created.setPasswordUrl ? (
          <>
            <p className="channel-note">
              <code>{created.setPasswordUrl}</code>
            </p>
            <p className="footnote">
              That link signs them in and lets them set a password. It expires in 24 hours and works
              once — treat it like a password, not like a profile URL.
            </p>
          </>
        ) : null}

        <div className="channel-actions">
          <button type="button" className="primary" onClick={() => setCreated(null)}>
            Add another
          </button>
        </div>
      </section>
    );
  }

  return (
    <form className="card full channel-form" onSubmit={submit}>
      <h2 className="card-label">Add an affiliate</h2>

      <div className="field-row">
        <div className="control control-grow">
          <label htmlFor="affiliate-name">Name</label>
          <input
            id="affiliate-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </div>
        <div className="control control-grow">
          <label htmlFor="affiliate-email">Email</label>
          <input
            id="affiliate-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="control">
          <label htmlFor="affiliate-program">Programme</label>
          <select
            id="affiliate-program"
            value={programId}
            onChange={(event) => setProgramId(event.target.value)}
          >
            <option value="">None yet</option>
            {programs.map((program) => (
              <option key={program.id} value={program.id}>
                {program.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="channel-actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add affiliate'}
        </button>
      </div>

      {error ? <p className="channel-status bad">{error}</p> : null}
    </form>
  );
}
