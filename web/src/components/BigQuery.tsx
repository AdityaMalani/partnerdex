import { useCallback, useEffect, useRef, useState } from 'react';
import {
  checkBigQuery,
  checkBigQueryApp,
  disconnectBigQuery,
  fetchBigQuery,
  saveBigQuery,
  saveBigQueryAppSource,
  syncBigQuery,
  type BigQueryAppSource,
  type BigQuerySettings,
} from '../api';
import { formatDateTime } from '../format';

/**
 * Where the top of the funnel comes from.
 *
 * The Partner API knows nothing before an install. Everything in front of it —
 * someone reading the listing, someone clicking Install — exists only in Google
 * Analytics, and only reaches this dashboard through the GA4 BigQuery export.
 *
 * The page is two cards because the data is at two levels. A Google Cloud
 * project and a service account are things a partner has one of. A GA4 export
 * dataset belongs to a GA4 *property*, and a partner who put a separate
 * measurement id on each listing has one per app — so the dataset sits with the
 * app, not with the account, and has no fallback. Guessing which property
 * belongs to an app is the one mistake that would quietly fill one listing's
 * funnel with another listing's traffic.
 *
 * Every field carries the click-path to its own value underneath it. These are
 * values that live in three different consoles, and a form that only names them
 * assumes the reader already knows which console to be in.
 */

const KEY_PLACEHOLDER = `{
  "type": "service_account",
  "project_id": "…",
  "private_key_id": "…",
  "private_key": "-----BEGIN PRIVATE KEY-----\\n…",
  "client_email": "partnerdex@….iam.gserviceaccount.com"
}`;

/** Shared busy/error/note plumbing for both cards. */
function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return { busy, error, note, setError, setNote, run };
}

/* ------------------------------------------------------------ card one */

/**
 * The account. One project, one key, one set of event names — everything that
 * does not vary between apps.
 */
function Account({
  settings,
  onChanged,
  onDatasets,
}: {
  settings: BigQuerySettings;
  onChanged: (next: BigQuerySettings) => void;
  /** Datasets the account can see, handed to the app card as suggestions. */
  onDatasets: (datasets: string[]) => void;
}) {
  const existing = settings.connection;

  const [projectId, setProjectId] = useState(existing?.projectId ?? '');
  const [location, setLocation] = useState(existing?.location ?? 'US');
  const [credentials, setCredentials] = useState('');
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  const { busy, error, note, setError, setNote, run } = useAction();

  /**
   * The job watcher below is a loop, not an interval, so nothing unsubscribes
   * it. Without this it keeps asking the server every two seconds — and keeps
   * writing to state through `onChanged` — for the rest of the tab's life if
   * the operator navigates away mid-ingest, which is a multi-minute window.
   */
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const save = () =>
    run('save', async () => {
      onChanged(
        await saveBigQuery({
          projectId,
          location,
          // Left out entirely when the box is empty, so editing the project
          // does not mean pasting the key again.
          ...(credentials.trim() ? { credentials: credentials.trim() } : {}),
        }),
      );
      setCredentials('');
      setNote('Saved. Run a test to confirm the account can reach the project.');
    });

  const test = () =>
    run('test', async () => {
      const { check, ...next } = await checkBigQuery();
      onChanged(next);
      if (check.ok) {
        onDatasets(check.datasets);
        setNote(
          `The account works. ${check.datasets.length} dataset(s) visible in ${location} — ` +
          'pick each app’s below.',
        );
      } else {
        setError(check.error ?? 'The connection could not be verified.');
      }
    });

  /**
   * Start the ingest, then watch the job.
   *
   * There is no result to await any more: the server forks the ingest so that a
   * multi-minute pull cannot hold the event loop and fail the platform health
   * check. So this starts it, then polls the settings surface — which carries
   * the job — until the run reports. The button stays busy throughout, which is
   * the same thing it did before and the same thing it means.
   */
  const sync = () =>
    run('sync', async () => {
      const { accepted: _accepted, ...started } = await syncBigQuery(false);
      onChanged(started);
      setNote('Pulling listing traffic in the background…');

      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        if (!mounted.current) return;
        const next = await fetchBigQuery();
        if (!mounted.current) return;
        onChanged(next);
        if (next.job.running) continue;
        if (next.job.error) {
          setError(next.job.error);
          return;
        }
        const result = next.job.result;
        setNote(
          result
            ? `Pulled ${result.rows} event(s) for ${result.apps.length} app(s).` +
              (result.skipped.length > 0 ? ` Skipped ${result.skipped.length}.` : '')
            : 'The sync finished.',
        );
        return;
      }
    });

  const disconnect = () =>
    run('disconnect', async () => {
      await disconnectBigQuery();
      onChanged({ ...settings, connection: null });
      setConfirmingDisconnect(false);
    });

  return (
    <div className="card full channel-form">
      <div className="card-head">
        <span className="card-label">{existing ? 'Google Cloud account' : 'Connect BigQuery'}</span>
      </div>
      <p className="card-subtitle">
        The project and the service account that read your GA4 exports.
      </p>

      {/* A stack rather than bare rows: several `field-row`s in a column have
          no spacing of their own, because everywhere else in this dashboard
          exactly one of them sits inside a list item that provides it. */}
      <div className="form-stack">
        <div className="field-row">
          <div className="control control-grow">
            <label htmlFor="bq-project">Google Cloud project ID</label>
            <input
              id="bq-project"
              type="text"
              value={projectId}
              placeholder="my-analytics-project"
              onChange={(event) => setProjectId(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="control control-narrow">
            <label htmlFor="bq-location">Default location</label>
            <input
              id="bq-location"
              type="text"
              value={location}
              placeholder="US"
              onChange={(event) => setLocation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {/* A wrong location answers "dataset not found", which sends people
                hunting for a typo in the dataset name instead. */}
          </div>
        </div>

        <div className="control control-grow">
          <label htmlFor="bq-credentials">
            Service-account key {existing ? '(leave empty to keep the current one)' : ''}
          </label>
          <textarea
            id="bq-credentials"
            className="bq-key"
            rows={6}
            value={credentials}
            placeholder={KEY_PLACEHOLDER}
            onChange={(event) => setCredentials(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="bq-key-hint"
          />
          {/* Where the file comes from, and the one instruction that prevents
              the most common failure: a key reflowed by a text editor. */}
          <span className="field-hint" id="bq-key-hint">
            Cloud console → IAM &amp; Admin → Service Accounts → <em>Create service account</em> →
            open it → Keys → Add key → Create new key → <strong>JSON</strong>. Grant it{' '}
            <strong>BigQuery Job User</strong> on the project and <strong>BigQuery Data Viewer</strong>{' '}
            on each dataset. Paste the file whole, exactly as downloaded — the <code>\n</code>{' '}
            escapes inside <code>private_key</code> must survive.
          </span>
        </div>

        {existing ? (
          <p className="channel-status">
            Using <code>{existing.clientEmail}</code>, key {existing.keyHint}. Saved{' '}
            {formatDateTime(existing.updatedAt)}.
          </p>
        ) : null}
      </div>

      <div className="channel-actions">
        <button
          type="button"
          className="primary"
          onClick={save}
          disabled={busy !== null || !projectId.trim()}
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={test} disabled={busy !== null || !existing}>
          {busy === 'test' ? 'Testing…' : 'Test connection'}
        </button>
        <button type="button" onClick={sync} disabled={busy !== null || !existing}>
          {busy === 'sync' ? 'Syncing…' : 'Sync now'}
        </button>
        {existing ? (
          confirmingDisconnect ? (
            <>
              <button type="button" className="danger" onClick={disconnect} disabled={busy !== null}>
                {busy === 'disconnect' ? 'Disconnecting…' : 'Confirm'}
              </button>
              <button type="button" onClick={() => setConfirmingDisconnect(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDisconnect(true)}
              disabled={busy !== null}
            >
              Disconnect
            </button>
          )
        ) : null}
      </div>

      {error ? <p className="channel-status bad">{error}</p> : null}
      {note ? <p className="channel-status good">{note}</p> : null}

      {confirmingDisconnect ? (
        <p className="footnote">
          Disconnecting deletes the stored key. The listing traffic already collected is kept — the
          funnel keeps its history and simply stops advancing.
        </p>
      ) : null}

      {!error && !note && existing?.lastError ? (
        <p className="channel-status bad">
          Last check failed
          {existing.checkedAt ? ` ${formatDateTime(existing.checkedAt)}` : ''}: {existing.lastError}
        </p>
      ) : null}

      {!error && !note && existing && !existing.lastError && existing.checkedAt ? (
        <p className="channel-status good">Verified {formatDateTime(existing.checkedAt)}.</p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ card two */

/**
 * One app's GA4 export.
 *
 * The dataset is the required field and the reason this card exists. The handle
 * only matters when several listings share one property; the location only when
 * this app's export sits in a different region from the rest.
 */
function SourceRow({
  source,
  defaultLocation,
  datasets,
  shared,
  onChanged,
}: {
  source: BigQueryAppSource;
  defaultLocation: string;
  /** Datasets the last account test found, offered as suggestions. */
  datasets: string[];
  /** True when another app here reads the same dataset. */
  shared: boolean;
  onChanged: (next: BigQueryAppSource) => void;
}) {
  const [dataset, setDataset] = useState(source.dataset ?? '');
  const [location, setLocation] = useState(source.locationOverridden ? source.location : '');
  const [handle, setHandle] = useState(source.handle ?? '');
  const { busy, error, note, setError, setNote, run } = useAction();

  useEffect(() => {
    setDataset(source.dataset ?? '');
    setLocation(source.locationOverridden ? source.location : '');
    setHandle(source.handle ?? '');
  }, [source.dataset, source.location, source.locationOverridden, source.handle]);

  const save = () =>
    run('save', async () => {
      onChanged(await saveBigQueryAppSource(source.appId, { dataset, location, handle }));
      setNote('Saved.');
    });

  /** Survives the note being cleared: it is a standing condition, not an event. */
  const [timezoneWarning, setTimezoneWarning] = useState<string | null>(null);

  const test = () =>
    run('test', async () => {
      const { check } = await checkBigQueryApp(source.appId);
      setTimezoneWarning(check.timezoneWarning);
      if (check.ok) {
        setNote(
          `Readable: ${check.tables} daily export table(s)` +
          (check.earliest && check.latest ? `, ${check.earliest} to ${check.latest}.` : '.'),
        );
      } else {
        setError(check.error ?? 'That dataset could not be verified.');
      }
    });

  const dirty =
    dataset.trim() !== (source.dataset ?? '') ||
    location.trim() !== (source.locationOverridden ? source.location : '') ||
    handle.trim() !== (source.handle ?? '');

  return (
    <li className="channel">
      <div className="channel-head">
        <span className="channel-name">{source.appName ?? `App ${source.appId}`}</span>
        <span className="channel-note">
          {source.eventCount > 0
            ? `${source.eventCount.toLocaleString()} listing event(s)` +
            (source.lastEventAt ? `, last ${formatDateTime(source.lastEventAt)}` : '')
            : 'No listing traffic collected yet'}
        </span>
        {source.dataset ? null : <span className="pill pill-churned">Not set up</span>}
      </div>

      <div className="form-stack">
        <div className="field-row">
          <div className="control control-grow">
            <label htmlFor={`bq-ds-${source.appId}`}>GA4 export dataset</label>
            <input
              id={`bq-ds-${source.appId}`}
              type="text"
              value={dataset}
              placeholder="analytics_123456789"
              onChange={(event) => setDataset(event.target.value)}
              list={datasets.length > 0 ? 'bq-dataset-names' : undefined}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`bq-ds-hint-${source.appId}`}
            />
            <span className="field-hint" id={`bq-ds-hint-${source.appId}`}>
              BigQuery → Explorer → under your project, the dataset named{' '}
              <code>analytics_&lt;property id&gt;</code>.
            </span>
          </div>

          <div className="control control-narrow">
            <label htmlFor={`bq-loc-${source.appId}`}>Location</label>
            <input
              id={`bq-loc-${source.appId}`}
              type="text"
              value={location}
              placeholder={defaultLocation}
              onChange={(event) => setLocation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`bq-loc-hint-${source.appId}`}
            />
            <span className="field-hint" id={`bq-loc-hint-${source.appId}`}>
              Fill in only if this export sits in a different region
            </span>
          </div>
        </div>

        <div className="control control-grow" style={{ paddingBottom: "5px" }}>
          <label htmlFor={`bq-handle-${source.appId}`}>Listing handle</label>
          <input
            id={`bq-handle-${source.appId}`}
            type="text"
            value={handle}
            placeholder="prefilled from the mapped App Store listing"
            onChange={(event) => setHandle(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`bq-handle-hint-${source.appId}`}
          />
        </div>
      </div>

      <div className="channel-actions">
        <button type="button" className="primary" onClick={save} disabled={busy !== null || !dirty}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={test}
          disabled={busy !== null || !source.dataset || dirty}
          title={dirty ? 'Save first — the test reads the stored dataset.' : undefined}
        >
          {busy === 'test' ? 'Testing…' : 'Test dataset'}
        </button>
      </div>

      {error ? <p className="channel-status bad">{error}</p> : null}
      {note ? <p className="channel-status good">{note}</p> : null}

      {/* Nothing is broken when this fires — the two calendars simply cut the
          day at different instants, which shows up as every daily column being
          a few visitors off Google's for no visible reason. */}
      {timezoneWarning ? <p className="channel-status bad">{timezoneWarning}</p> : null}

      {/* Only a problem where the dataset is shared. On a property of its own,
          counting everything in it is the right answer — and the safer one: a
          listing addresses some of its pages by numeric id, so filtering on the
          handle drops real views. */}
      {!error && !note && source.dataset && !source.handle && shared ? (
        <p className="channel-status bad">
          No listing handle, and <code>{source.dataset}</code> is shared with another app — so
          every event in it is attributed to this one. Add the handle to separate them.
        </p>
      ) : null}
    </li>
  );
}

export function BigQuery() {
  const [settings, setSettings] = useState<BigQuerySettings | null>(null);
  const [datasets, setDatasets] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchBigQuery()
      .then((result) => {
        if (!cancelled) setSettings(result);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const replaceSource = useCallback((next: BigQueryAppSource) => {
    setSettings((current) =>
      current
        ? {
          ...current,
          sources: current.sources.map((entry) => (entry.appId === next.appId ? next : entry)),
        }
        : current,
    );
  }, []);

  if (error) {
    return (
      <div className="notice error">
        <h2>Could not load the BigQuery settings</h2>
        <p>{error}</p>
      </div>
    );
  }

  if (!settings) return <div className="skeleton">Loading BigQuery settings…</div>;

  return (
    <>
      <Account settings={settings} onChanged={setSettings} onDatasets={setDatasets} />

      {/* Suggestions from the last account test, shared by every dataset input
          so the value is picked rather than transcribed. */}
      <datalist id="bq-dataset-names">
        {datasets.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <div className="card full">
        <div className="card-head" style={{ paddingBottom: "10px" }}>
          <span className="card-label">GA4 export per app</span>
        </div>

        {settings.sources.length === 0 ? (
          <p className="footnote">
            No apps in reporting scope yet. They appear here once the Partner API sync has
            discovered them.
          </p>
        ) : (
          <ul className="channel-list">
            {settings.sources.map((source) => (
              <SourceRow
                key={source.appId}
                source={source}
                defaultLocation={settings.connection?.location ?? 'US'}
                datasets={datasets}
                shared={
                  source.dataset !== null &&
                  settings.sources.filter((other) => other.dataset === source.dataset).length > 1
                }
                onChanged={replaceSource}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
