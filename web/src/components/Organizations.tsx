import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  checkOrganization,
  createOrganization,
  fetchOrganizations,
  removeOrganization,
  updateOrganization,
  type Organization,
  type OrganizationCheck,
} from '../api';
import { formatDateTime } from '../format';

/**
 * One figure with its label: the tile this page is built out of.
 *
 * Local for now because this is its only caller; it moves somewhere shared the
 * moment a second page wants the same tile.
 */
function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

/**
 * The Partner organizations this instance syncs.
 *
 * A dashboard, not a form with prose around it: each organization is a row of
 * figures — apps, last sync, what it is doing now — and the words are reserved
 * for the two things a reader cannot infer. Those two are the removal notice,
 * because the opposite of what happens is what a reader would assume, and the
 * environment badge, because a row seeded from `PARTNER_ORG_<n>_*` behaves
 * differently the moment it is edited here.
 *
 * The token is write-only. It is posted once, never returned, and shown as four
 * characters afterwards — so replacing one is possible without displaying it,
 * and the field for it is empty on every render rather than pre-filled with
 * something that only looks like the stored value.
 */

function CheckLine({ check }: { check: OrganizationCheck }) {
  if (!check.ok) return <p className="channel-status bad">{check.error}</p>;
  return <p className="channel-status good">{check.note}</p>;
}

/** Last success, current phase, last error — the three states of one row. */
function Health({ org }: { org: Organization }) {
  if (org.disabledAt) {
    return <span className="channel-note">Removed {formatDateTime(org.disabledAt)}</span>;
  }
  if (org.phase) {
    return <span className="channel-note">Syncing: {org.phase}</span>;
  }
  if (org.syncError) {
    return (
      <span className="channel-status bad">
        Failed{org.syncErrorPhase ? ` in ${org.syncErrorPhase}` : ''}: {org.syncError}
      </span>
    );
  }
  return (
    <span className="channel-note">
      {org.lastSyncAt ? `Synced ${formatDateTime(org.lastSyncAt)}` : 'Never synced'}
    </span>
  );
}

function OrganizationRow({
  org,
  onChanged,
}: {
  org: Organization;
  onChanged: (next: Organization[]) => void;
}) {
  const [label, setLabel] = useState(org.label);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<OrganizationCheck | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setLabel(org.label);
  }, [org.label]);

  const run = async (
    name: string,
    action: () => Promise<{ organizations: Organization[]; check?: OrganizationCheck }>,
  ) => {
    setBusy(name);
    setError(null);
    setCheck(null);
    try {
      const result = await action();
      onChanged(result.organizations);
      if (result.check) setCheck(result.check);
      setToken('');
      setConfirming(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const dirty = label.trim() !== org.label || token.trim().length > 0;

  return (
    <li className="channel">
      <div className="channel-head">
        <span className="channel-name">{org.label}</span>
        <span className="channel-note">
          {org.id} · {org.apps.toLocaleString()} app{org.apps === 1 ? '' : 's'}
        </span>
        <Health org={org} />
        {org.hasToken ? (
          <span className="pill" title="Stored on the server. Never sent to this page.">
            Token ····{org.tokenHint}
          </span>
        ) : (
          <span className="pill pill-churned">No token</span>
        )}
        {org.source === 'env' ? (
          <span className="pill" title="Seeded from PARTNER_ORG_<n>_*. Saving here takes it over.">
            From env
          </span>
        ) : null}
      </div>

      <div className="field-row">
        <div className="control control-grow">
          <label htmlFor={`org-label-${org.id}`}>Name</label>
          <input
            id={`org-label-${org.id}`}
            type="text"
            value={label}
            placeholder={org.id}
            onChange={(event) => setLabel(event.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="control control-grow">
          <label htmlFor={`org-token-${org.id}`}>
            {org.hasToken ? 'Replace token' : 'Access token'}
          </label>
          <input
            id={`org-token-${org.id}`}
            type="password"
            value={token}
            placeholder={org.hasToken ? 'Leave blank to keep the stored one' : 'Paste to restore'}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="channel-actions">
          <button
            type="button"
            className="primary"
            disabled={busy !== null || !dirty}
            onClick={() =>
              run('save', () =>
                updateOrganization(org.id, {
                  label: label.trim(),
                  ...(token.trim() ? { token: token.trim() } : {}),
                }),
              )
            }
          >
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={busy !== null || !org.hasToken}
            onClick={() => run('check', () => checkOrganization(org.id))}
          >
            {busy === 'check' ? 'Checking…' : 'Check'}
          </button>
          {org.disabledAt ? null : confirming ? (
            <>
              <button
                type="button"
                className="danger"
                disabled={busy !== null}
                onClick={() => run('remove', () => removeOrganization(org.id))}
              >
                {busy === 'remove' ? 'Removing…' : 'Confirm'}
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" disabled={busy !== null} onClick={() => setConfirming(true)}>
              Remove
            </button>
          )}
        </div>
      </div>

      {error ? <p className="channel-status bad">{error}</p> : null}
      {check ? <CheckLine check={check} /> : null}

      {!error && !check && org.checkedAt ? (
        <p className={org.lastError ? 'channel-status bad' : 'channel-status'}>
          {org.lastError
            ? `Last check failed ${formatDateTime(org.checkedAt)}: ${org.lastError}`
            : `${org.checkNote ?? 'Checked'} ${formatDateTime(org.checkedAt)}`}
        </p>
      ) : null}

      {/* The two facts a reader cannot infer, and only when they apply. */}
      {org.envDiffers ? (
        <p className="footnote">
          PARTNER_ORG_&lt;n&gt;_TOKEN for this organization differs from the stored one. The stored
          one is in use.
        </p>
      ) : null}

      {confirming ? (
        <p className="footnote">
          Removing forgets the token and stops the sync. Its {org.apps.toLocaleString()} app
          {org.apps === 1 ? '' : 's'}, every transaction and event already collected, and its sync
          watermarks are all kept — adding it back resumes rather than re-reading history.
        </p>
      ) : null}
    </li>
  );
}

function AddOrganization({ onAdded }: { onAdded: (next: Organization[]) => void }) {
  const [organizationId, setOrganizationId] = useState('');
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<OrganizationCheck | null>(null);
  const [refused, setRefused] = useState(false);

  const submit = async (event: React.FormEvent, force = false) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setCheck(null);
    try {
      const result = await createOrganization({
        organizationId: organizationId.trim(),
        label: label.trim(),
        token: token.trim(),
        ...(force ? { force: true } : {}),
      });
      onAdded(result.organizations);
      setCheck(result.check);
      setOrganizationId('');
      setLabel('');
      setToken('');
      setRefused(false);
    } catch (cause) {
      setError((cause as Error).message);
      setRefused(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card full channel-form" onSubmit={submit}>
      <h2 className="card-label">Add an organization</h2>
      <p className="card-subtitle">
        The id is the number in your Partner dashboard URL. The token is checked against the Partner
        API before it is stored, and is never shown again.
      </p>

      <div className="field-row">
        <div className="control">
          <label htmlFor="org-new-id">Organization id</label>
          <input
            id="org-new-id"
            type="text"
            value={organizationId}
            onChange={(event) => setOrganizationId(event.target.value)}
            autoComplete="off"
            inputMode="numeric"
            required
          />
        </div>

        <div className="control">
          <label htmlFor="org-new-label">Name</label>
          <input
            id="org-new-label"
            type="text"
            value={label}
            placeholder="Optional"
            onChange={(event) => setLabel(event.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="control control-grow">
          <label htmlFor="org-new-token">Access token</label>
          <input
            id="org-new-token"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>

        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Checking…' : 'Add'}
        </button>
      </div>

      {error ? <p className="channel-status bad">{error}</p> : null}
      {check ? <CheckLine check={check} /> : null}

      {/* A refusal is usually a wrong token; occasionally it is a network that
          was down for four seconds. The way past it is named rather than
          hidden, and the row it writes carries the failed check. */}
      {refused ? (
        <button type="button" disabled={busy} onClick={(event) => submit(event, true)}>
          Save without checking
        </button>
      ) : null}
    </form>
  );
}

export function Organizations() {
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchOrganizations()
      .then((result) => {
        if (!cancelled) setOrganizations(result.organizations);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const replace = useCallback((next: Organization[]) => setOrganizations(next), []);

  if (error) {
    return (
      <div className="notice error">
        <h2>Could not load organizations</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!organizations) return <div className="skeleton">Loading organizations…</div>;

  const live = organizations.filter((org) => org.disabledAt === null);
  const apps = live.reduce((sum, org) => sum + org.apps, 0);
  const failing = live.filter((org) => org.syncError !== null || org.lastError !== null).length;

  return (
    <>
      <div className="stat-row">
        <Stat label="Organizations" value={live.length.toLocaleString()} />
        <Stat label="Apps covered" value={apps.toLocaleString()} />
        <Stat
          label="Reporting trouble"
          value={failing.toLocaleString()}
          note={failing > 0 ? 'See the rows below' : null}
        />
      </div>

      {organizations.length === 0 ? (
        <div className="notice">
          <h2>No organization configured</h2>
          <p>Nothing syncs until one is added. Everything else on the dashboard still works.</p>
        </div>
      ) : (
        <div className="card full">
          <div className="card-head">
            <span className="card-label">Organizations</span>
            <span className="card-subtitle">
              One row per Partner organization. Reports cover all of them unless the selector says
              otherwise.
            </span>
          </div>
          <ul className="channel-list">
            {organizations.map((org) => (
              <OrganizationRow key={org.id} org={org} onChanged={replace} />
            ))}
          </ul>
        </div>
      )}

      <AddOrganization onAdded={replace} />
    </>
  );
}
