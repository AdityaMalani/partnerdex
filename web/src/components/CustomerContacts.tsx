import { useEffect, useRef } from 'react';
import type { ContactShop, ContactSummary } from '../api';
import { formatFullDate, formatValue } from '../format';

/**
 * The people behind one merchant, on that merchant's page.
 *
 * Read-only on purpose. Editing a person, matching them to a store and
 * suppressing them all live on the Contacts page; this tab answers "who do I
 * talk to at this store, and when did they last open the app".
 *
 * Seen dates are per store: a collaborator who works across ten stores was
 * last seen *here* on a different day than they were last seen anywhere.
 */

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  staff: 'Staff',
  collaborator: 'Collaborator',
};

const ROLE_RANK: Record<string, number> = { owner: 0, staff: 1, collaborator: 2 };

const SOURCE_LABEL: Record<string, string> = {
  app_capture: 'App login',
  csv_import: 'CSV import',
};

function personName(row: ContactSummary): string {
  return [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
}

function shopLabel(shop: ContactShop): string {
  return shop.name || shop.domain || shop.shopId;
}

function earliest(values: Array<string | null>): string | null {
  return values.filter((value): value is string => !!value).sort()[0] ?? null;
}

function latest(values: Array<string | null>): string | null {
  return values.filter((value): value is string => !!value).sort().at(-1) ?? null;
}

/** One person as this store sees them: their role here and their dates here. */
export interface StoreContact {
  contact: ContactSummary;
  role: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  otherShops: ContactShop[];
}

/**
 * Folds a person's memberships down to this store.
 *
 * A person linked to the same store under two apps has two rows in
 * `contact_shops`; for this page they are one person, with the senior role and
 * the widest span of dates.
 */
export function toStoreContacts(rows: ContactSummary[], shopId: string): StoreContact[] {
  return rows
    .map((contact) => {
      const here = contact.shops.filter((shop) => shop.shopId === shopId);
      const role =
        [...here].sort((a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9))[0]?.role ??
        contact.role ??
        'staff';
      const seen = new Set<string>();
      const otherShops = contact.shops.filter((shop) => {
        if (shop.shopId === shopId || seen.has(shop.shopId)) return false;
        seen.add(shop.shopId);
        return true;
      });
      return {
        contact,
        role,
        firstSeenAt: earliest(here.map((shop) => shop.firstSeenAt)),
        lastSeenAt: latest(here.map((shop) => shop.lastSeenAt)),
        otherShops,
      };
    })
    .sort(
      (a, b) =>
        (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) ||
        (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '') ||
        (personName(a.contact) || a.contact.email).localeCompare(
          personName(b.contact) || b.contact.email,
        ),
    );
}

function daysAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function ContactModal({ row, onClose }: { row: StoreContact; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { contact } = row;
  const name = personName(contact);

  // A native <dialog>, as the reviews modal uses: showModal brings the focus
  // trap, the inert page behind it and the top layer.
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <dialog
      ref={dialog}
      className="modal contact-modal"
      tabIndex={-1}
      onClose={onClose}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === dialog.current) onClose();
      }}
      aria-labelledby="contact-modal-title"
    >
      <div className="modal-head">
        <div>
          <h2 className="contact-modal-name" id="contact-modal-title">
            {name || contact.email}
            {contact.isSuppressed ? <span className="pill pill-suppressed">Suppressed</span> : null}
          </h2>
          {name ? <span className="contact-email">{contact.email}</span> : null}
        </div>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <dl className="contact-facts">
        <div>
          <dt>Role</dt>
          <dd>{ROLE_LABEL[row.role] ?? row.role}</dd>
        </div>
        <div>
          <dt>Added by</dt>
          <dd>{SOURCE_LABEL[contact.source] ?? contact.source.replace(/_/g, ' ')}</dd>
        </div>
        <div>
          <dt>First seen</dt>
          <dd>{row.firstSeenAt ? formatFullDate(row.firstSeenAt) : '—'}</dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>
            {row.lastSeenAt ? (
              <>
                {formatFullDate(row.lastSeenAt)}
                <span className="cell-note">{daysAgo(row.lastSeenAt)}</span>
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
      </dl>

      {!row.lastSeenAt ? (
        <p className="footnote">
          {contact.source === 'csv_import'
            ? 'Imported from the contacts CSV, which carries no dates. First and last seen fill in the next time this person opens the app.'
            : 'No app login recorded for this store yet.'}
        </p>
      ) : null}

      {row.otherShops.length > 0 ? (
        <div className="contact-modal-section">
          <span className="card-label">Other stores</span>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Store</th>
                  <th>Role</th>
                  <th>MRR</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {row.otherShops.map((shop) => (
                  <tr key={shop.shopId}>
                    <td>
                      <a
                        className="customer-link"
                        href={`#/customers/${encodeURIComponent(shop.shopId)}/contacts`}
                        onClick={onClose}
                      >
                        <span className="customer-name">{shopLabel(shop)}</span>
                      </a>
                    </td>
                    <td>{ROLE_LABEL[shop.role] ?? shop.role}</td>
                    <td>{formatValue(shop.mrr, 'money', shop.currency)}</td>
                    <td>{shop.lastSeenAt ? formatFullDate(shop.lastSeenAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

export function CustomerContacts({
  rows,
  error,
  selected,
  onSelect,
}: {
  rows: StoreContact[] | null;
  error: string | null;
  selected: string | null;
  onSelect: (email: string | null) => void;
}) {
  if (error) {
    return (
      <div className="notice error">
        <h2>Could not load contacts</h2>
        <p>{error}</p>
      </div>
    );
  }
  if (!rows) return <div className="skeleton">Loading contacts…</div>;

  const open = rows.find((row) => row.contact.email === selected) ?? null;

  return (
    <div className="card full">
      <div className="card-head">
        <span className="card-label">Contacts</span>
      </div>
      {rows.length === 0 ? (
        <p className="footnote">
          No one is linked to this store yet. People appear here when they log in to the app, or
          when the Contacts page matches them to this store.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="contacts-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Email</th>
                <th>First seen</th>
                <th>Last seen</th>
                <th>Other stores</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const name = personName(row.contact);
                return (
                  <tr
                    key={row.contact.email}
                    className={row.contact.isSuppressed ? 'contact-row-suppressed' : undefined}
                  >
                    <td>
                      <button
                        type="button"
                        className="link-button contact-open"
                        onClick={() => onSelect(row.contact.email)}
                      >
                        {name || row.contact.email}
                      </button>
                      {row.contact.isSuppressed ? (
                        <span className="pill pill-suppressed">Suppressed</span>
                      ) : null}
                    </td>
                    <td>{ROLE_LABEL[row.role] ?? row.role}</td>
                    <td className="contact-email">{row.contact.email}</td>
                    <td>{row.firstSeenAt ? formatFullDate(row.firstSeenAt) : '—'}</td>
                    <td>
                      {row.lastSeenAt ? (
                        <>
                          {formatFullDate(row.lastSeenAt)}
                          <span className="cell-note">{daysAgo(row.lastSeenAt)}</span>
                        </>
                      ) : (
                        <span className="muted-cell">Not seen yet</span>
                      )}
                    </td>
                    <td>
                      {row.otherShops.length > 0 ? `+${row.otherShops.length}` : <span className="muted-cell">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open ? <ContactModal row={open} onClose={() => onSelect(null)} /> : null}
    </div>
  );
}
