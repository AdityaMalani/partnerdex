import { useEffect, useState } from 'react';
import {
  fetchContactCandidates,
  fetchContacts,
  matchContactToShop,
  setContactSuppressed,
  type ContactLinkedFilter,
  type ContactShop,
  type ContactShopCandidate,
  type ContactSummary,
} from '../api';
import { formatFullDate } from '../format';

/**
 * The people behind the stores.
 *
 * Search runs on the server: the list is the send-list, and finding one person
 * among hundreds by the email on a support ticket should not mean shipping
 * the whole table to the browser first.
 */

const PAGE_SIZE = 50;

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  staff: 'Staff',
  collaborator: 'Collaborator',
};

const SOURCE_LABEL: Record<string, string> = {
  app_capture: 'App login',
  csv_import: 'CSV import',
};

const LINKED_FILTERS: Array<{ value: ContactLinkedFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'unlinked', label: 'Unlinked' },
  { value: 'ambiguous', label: 'Ambiguous' },
  { value: 'suppressed', label: 'Suppressed' },
];

type SortKey = 'name' | 'customer' | 'created' | 'recent';

/** First click uses this direction. A second click on the same title flips it. */
const NATURAL_SORT: Record<SortKey, string> = {
  name: 'name',
  customer: 'customer',
  created: 'created',
  recent: 'recent',
};

const FLIPPED_SORT: Record<SortKey, string> = {
  name: 'name_desc',
  customer: 'customer_desc',
  created: 'created_asc',
  recent: 'recent_asc',
};

function sortKeyOf(sort: string): SortKey | null {
  if (sort === 'name' || sort === 'name_desc') return 'name';
  if (sort === 'customer' || sort === 'customer_desc') return 'customer';
  if (sort === 'created' || sort === 'created_asc') return 'created';
  if (sort === 'recent' || sort === 'recent_asc') return 'recent';
  return null;
}

function sortDir(sort: string): 'asc' | 'desc' {
  return sort.endsWith('_desc') || sort === 'created' || sort === 'recent' ? 'desc' : 'asc';
}

function nextSort(current: string, key: SortKey): string {
  if (current === NATURAL_SORT[key]) return FLIPPED_SORT[key];
  if (current === FLIPPED_SORT[key]) return NATURAL_SORT[key];
  return NATURAL_SORT[key];
}

function personName(row: ContactSummary): string {
  return [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
}

function displayName(row: ContactSummary): string {
  return personName(row) || row.email;
}

function shopLabel(shop: ContactShop): string {
  return shop.name || shop.domain || shop.shopId;
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: string;
  onSort: (sort: string) => void;
  className?: string;
}) {
  const active = sortKeyOf(sort) === sortKey;
  const dir = sortDir(sort);
  return (
    <th className={className} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className={active ? 'th-sort is-active' : 'th-sort'}
        onClick={() => onSort(nextSort(sort, sortKey))}
      >
        {label}
        {active ? (
          <span className="th-sort-mark" aria-hidden="true">
            {dir === 'asc' ? '↑' : '↓'}
          </span>
        ) : null}
      </button>
    </th>
  );
}

function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source.replace(/_/g, ' ');
}

/** Waits for the typing to stop before asking the server. */
function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * Choosing which merchant a contact belongs to.
 *
 * Candidates come from the shops table by name or domain. The partner
 * recognises the store; the importer would not guess.
 */
function MatchPicker({
  contact,
  appId,
  onMatched,
}: {
  contact: ContactSummary;
  appId: string;
  onMatched: () => void;
}) {
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<ContactShopCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounced = useDebounced(search, 250);

  useEffect(() => {
    let cancelled = false;
    fetchContactCandidates(debounced)
      .then((result) => {
        if (!cancelled) setCandidates(result.candidates);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  const link = (shopId: string) => {
    setBusy(true);
    setError(null);
    matchContactToShop(contact.email, shopId, appId)
      .then(onMatched)
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="review-picker">
      <label htmlFor={`contact-picker-${contact.email}`}>
        Which store does <strong>{displayName(contact)}</strong> belong to?
      </label>
      <input
        id={`contact-picker-${contact.email}`}
        type="search"
        placeholder="Store name, myshopify domain, or shop id"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        autoComplete="off"
      />
      {error ? <p className="review-picker-error">{error}</p> : null}
      <ul className="review-candidates">
        {candidates.map((candidate) => (
          <li key={candidate.shopId}>
            <button type="button" disabled={busy} onClick={() => link(candidate.shopId)}>
              <span className="candidate-name">
                {candidate.name ?? candidate.domain ?? candidate.shopId}
              </span>
              <span className="candidate-meta">{candidate.domain ?? `Shop ${candidate.shopId}`}</span>
            </button>
          </li>
        ))}
        {candidates.length === 0 ? <li className="candidate-empty">No merchants match.</li> : null}
      </ul>
    </div>
  );
}

function CustomersCell({
  row,
  appId,
  resolving,
  onToggleResolve,
  onMatched,
}: {
  row: ContactSummary;
  appId: string;
  resolving: boolean;
  onToggleResolve: () => void;
  onMatched: () => void;
}) {
  const primary = row.primaryShop;
  const extra = Math.max(row.shops.length - 1, 0);
  const needsMatch = !primary || primary.matchMethod === 'ambiguous' || primary.matchMethod === 'none';

  return (
    <td className="col-customer">
      {primary ? (
        <div className="contact-customer">
          <a
            className="customer-link contact-customer-link"
            href={`#/customers/${encodeURIComponent(primary.shopId)}`}
          >
            <span className="customer-name">{shopLabel(primary)}</span>
          </a>
          <span className="contact-role">
            {ROLE_LABEL[primary.role] ?? primary.role}
            {extra > 0 ? ` · +${extra}` : ''}
          </span>
          {primary.matchMethod === 'ambiguous' ? (
            <span className="pill pill-ambiguous" title="More than one shop answered to this domain.">
              Ambiguous
            </span>
          ) : null}
        </div>
      ) : (
        <span className="pill pill-ambiguous">Unlinked</span>
      )}
      {needsMatch ? (
        <button type="button" className="link-button" onClick={onToggleResolve}>
          {resolving ? 'Cancel' : 'Resolve'}
        </button>
      ) : null}
      {resolving ? <MatchPicker contact={row} appId={appId} onMatched={onMatched} /> : null}
    </td>
  );
}

export function Contacts({ appId }: { appId: string }) {
  const [search, setSearch] = useState('');
  const [linked, setLinked] = useState<ContactLinkedFilter>('all');
  const [sort, setSort] = useState('recent');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<ContactSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState({ all: 0, unlinked: 0, ambiguous: 0, suppressed: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);

  const debounced = useDebounced(search, 250);

  useEffect(() => {
    setPage(0);
  }, [debounced, linked, sort, appId]);

  const load = () => {
    setLoading(true);
    return fetchContacts({
      search: debounced,
      linked,
      sort,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      appId,
    })
      .then((result) => {
        setRows(result.contacts);
        setTotal(result.total);
        setTotals(result.totals);
        setError(null);
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchContacts({
      search: debounced,
      linked,
      sort,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      appId,
    })
      .then((result) => {
        if (cancelled) return;
        setRows(result.contacts);
        setTotal(result.total);
        setTotals(result.totals);
        setError(null);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, linked, sort, page, appId]);

  const lastPage = Math.max(Math.ceil(total / PAGE_SIZE) - 1, 0);

  const toggleSuppressed = (row: ContactSummary) => {
    setBusyEmail(row.email);
    setContactSuppressed(row.email, !row.isSuppressed)
      .then(() => load())
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusyEmail(null));
  };

  return (
    <>
      <div className="controls">
        <div className="control control-search">
          <label htmlFor="contact-search">Find a person</label>
          <input
            id="contact-search"
            type="search"
            placeholder="Name or email"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="control">
          <label htmlFor="contact-linked">Show</label>
          <select
            id="contact-linked"
            value={linked}
            onChange={(event) => setLinked(event.target.value as ContactLinkedFilter)}
          >
            {LINKED_FILTERS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
                {item.value !== 'all' && totals[item.value] > 0
                  ? ` (${totals[item.value]})`
                  : item.value === 'all' && totals.all > 0
                    ? ` (${totals.all})`
                    : ''}
              </option>
            ))}
          </select>
        </div>

        <p className="control-note">
          {loading && rows.length === 0
            ? 'Searching…'
            : `${total.toLocaleString()} contact${total === 1 ? '' : 's'}${
                debounced ? ` matching “${debounced}”` : ''
              }.`}
        </p>
      </div>

      {error ? (
        <div className="notice error">
          <h2>Could not load contacts</h2>
          <p>{error}</p>
        </div>
      ) : null}

      {!error && !loading && rows.length === 0 ? (
        <div className="notice">
          <h2>No contacts found</h2>
          <p>
            {debounced || linked !== 'all'
              ? 'Nothing matches those filters. Search matches name and email.'
              : 'Import a contacts CSV or wait for an app to push a login, then reload.'}
          </p>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <div className="card full">
          <div className="table-wrap">
            <table className="customer-table contacts-table">
              <thead>
                <tr>
                  <SortHeader label="Name" sortKey="name" sort={sort} onSort={setSort} />
                  <th>Source</th>
                  <SortHeader label="Created" sortKey="created" sort={sort} onSort={setSort} />
                  <SortHeader label="Last seen" sortKey="recent" sort={sort} onSort={setSort} />
                  <SortHeader
                    label="Customers"
                    sortKey="customer"
                    sort={sort}
                    onSort={setSort}
                    className="col-customer"
                  />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.email}
                    className={row.isSuppressed ? 'contact-row-suppressed' : undefined}
                  >
                    <td>
                      <div className="contact-person">
                        <span>
                          <span className="customer-name">{displayName(row)}</span>
                          {row.isSuppressed ? (
                            <span className="pill pill-suppressed">Suppressed</span>
                          ) : null}
                        </span>
                        {personName(row) ? (
                          <span className="contact-email">{row.email}</span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      {row.source ? (
                        <span className={`pill pill-source-${row.source}`}>{sourceLabel(row.source)}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{row.createdAt ? formatFullDate(row.createdAt) : '—'}</td>
                    <td>{row.lastSeenAt ? formatFullDate(row.lastSeenAt) : '—'}</td>
                    <CustomersCell
                      row={row}
                      appId={appId}
                      resolving={resolving === row.email}
                      onToggleResolve={() =>
                        setResolving((current) => (current === row.email ? null : row.email))
                      }
                      onMatched={() => {
                        setResolving(null);
                        load();
                      }}
                    />
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        disabled={busyEmail === row.email}
                        onClick={() => toggleSuppressed(row)}
                      >
                        {row.isSuppressed ? 'Unsuppress' : 'Suppress'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="contact-footnote">
            Suppressed rows are excluded from any send. A “+N” is a person linked to several
            stores — one contact, many memberships.
          </p>

          {total > PAGE_SIZE ? (
            <div className="pager">
              <button type="button" onClick={() => setPage((n) => n - 1)} disabled={page === 0}>
                Previous
              </button>
              <span>
                {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of{' '}
                {total.toLocaleString()}
              </span>
              <button
                type="button"
                onClick={() => setPage((n) => n + 1)}
                disabled={page >= lastPage}
              >
                Next
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
