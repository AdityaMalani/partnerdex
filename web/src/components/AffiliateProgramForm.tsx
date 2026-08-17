import { useState } from 'react';
import {
  createProgram,
  updateProgram,
  type ProgramDetail,
  type ProgramTermsInput,
} from '../api';
import { REVENUE_COMPONENT_LABELS } from './AffiliateData';

/**
 * Setting a programme's terms.
 *
 * The screen that was missing. `POST` and `PATCH /api/affiliates/programs` have
 * existed and validated carefully for a while; nothing in the dashboard called
 * them, so the Programs page was a read-only card whose empty state pointed at
 * an import. This is the form, and it is deliberately the same fields the API
 * takes — no derived conveniences, no percentage-to-fraction helper beyond the
 * one below, because a settings screen that reshapes its own payload is a
 * second validator to keep in step with the first.
 *
 * ## The rate is entered as a percentage and stored as a fraction
 *
 * One conversion, here, at the edge, mirroring the one the engine does at the
 * database boundary. Every human writes "20"; the column stores `0.2`; and the
 * API refuses anything above 1 precisely because that mistake overpays by a
 * hundredfold. Doing the conversion in the field rather than asking an operator
 * to type `0.2` removes the mistake instead of catching it.
 *
 * ## Why editing says what it will and will not move
 *
 * A change to a money term writes a new version effective from now, so it
 * changes what referrals earn from here on and leaves earned commissions alone.
 * That is not what a settings form usually does, and the difference is worth a
 * line of text — the one place on this screen prose earns its space.
 */

const EMPTY: ProgramTermsInput = {
  name: '',
  listingUrl: '',
  appId: '',
  commissionRate: 0.2,
  revenueComponents: ['subscription'],
  durationMonths: null,
  unassignAfterUninstallDays: 30,
  requireApproval: false,
  status: 'active',
  payoutBasis: 'percent_of_gross',
  flatAmount: 0,
  flatCurrency: '',
  recurrence: 'recurring',
  enforceUnassignAfterUninstall: true,
  minimumPayout: 0,
  termsUrl: '',
};

/** `0.2` ⇄ `20`. The only unit conversion on this screen. */
const asPercent = (fraction: number): string =>
  Number.isFinite(fraction) ? String(Math.round(fraction * 10000) / 100) : '';

function fromProgram(program: ProgramDetail): ProgramTermsInput {
  return {
    name: program.name,
    appId: program.appId,
    listingUrl: program.listingUrl,
    commissionRate: program.commissionRate,
    revenueComponents: program.revenueComponents,
    durationMonths: program.durationMonths,
    unassignAfterUninstallDays: program.unassignAfterUninstallDays,
    requireApproval: program.requireApproval,
    status: program.status,
    payoutBasis: program.payoutBasis,
    flatAmount: program.flatAmount,
    flatCurrency: program.flatCurrency,
    recurrence: program.recurrence,
    enforceUnassignAfterUninstall: program.enforceUnassignAfterUninstall,
    minimumPayout: program.minimumPayout,
    termsUrl: program.termsUrl,
  };
}

/** A whole number of months or days, or null. Blank is null, never zero. */
function optionalCount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export function AffiliateProgramForm({
  program,
  onSaved,
  onCancel,
}: {
  /** Absent means create. */
  program?: ProgramDetail;
  onSaved: (program: ProgramDetail) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState<ProgramTermsInput>(
    program ? fromProgram(program) : { ...EMPTY },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof ProgramTermsInput>(key: K, value: ProgramTermsInput[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const flat = form.payoutBasis === 'flat_per_referral';

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = program
        ? await updateProgram(program.id, form)
        : await createProgram(form);
      onSaved(result.program);
    } catch (cause) {
      // The server names the field and why. Repeating that verbatim is more
      // useful than a generic failure line, and it is the only copy of the rule.
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleComponent = (component: string): void => {
    const current = form.revenueComponents ?? [];
    set(
      'revenueComponents',
      current.includes(component)
        ? current.filter((entry) => entry !== component)
        : [...current, component],
    );
  };

  return (
    <form className="card full channel-form" onSubmit={submit}>
      <h2 className="card-label">{program ? 'Edit terms' : 'New programme'}</h2>

      <div className="field-row">
        <div className="control control-grow">
          <label htmlFor="program-name">Name</label>
          <input
            id="program-name"
            value={String(form.name ?? '')}
            onChange={(event) => set('name', event.target.value)}
            required
          />
        </div>
        <div className="control">
          <label htmlFor="program-status">Status</label>
          <select
            id="program-status"
            value={String(form.status ?? 'active')}
            onChange={(event) => set('status', event.target.value as 'active' | 'closed')}
          >
            <option value="active">Active</option>
            <option value="closed">Closed</option>
          </select>
        </div>
      </div>

      <div className="field-row">
        <div className="control control-grow">
          <label htmlFor="program-listing">Listing URL</label>
          <input
            id="program-listing"
            value={String(form.listingUrl ?? '')}
            onChange={(event) => set('listingUrl', event.target.value)}
            placeholder="https://apps.example.com/your-app"
          />
        </div>
        <div className="control">
          <label htmlFor="program-app">App id</label>
          <input
            id="program-app"
            value={String(form.appId ?? '')}
            onChange={(event) => set('appId', event.target.value)}
            placeholder="Blank until the first sync"
          />
        </div>
      </div>

      <div className="field-row">
        <div className="control">
          <label htmlFor="program-basis">Pays</label>
          <select
            id="program-basis"
            value={String(form.payoutBasis ?? 'percent_of_gross')}
            onChange={(event) =>
              set('payoutBasis', event.target.value as ProgramDetail['payoutBasis'])
            }
          >
            <option value="percent_of_gross">A share of gross</option>
            <option value="flat_per_referral">A flat bounty per referral</option>
          </select>
        </div>

        {flat ? (
          <>
            <div className="control">
              <label htmlFor="program-flat">Bounty</label>
              <input
                id="program-flat"
                type="number"
                min="0"
                step="0.01"
                value={String(form.flatAmount ?? 0)}
                onChange={(event) => set('flatAmount', Number(event.target.value))}
              />
            </div>
            <div className="control">
              <label htmlFor="program-currency">Currency</label>
              <input
                id="program-currency"
                value={String(form.flatCurrency ?? '')}
                onChange={(event) => set('flatCurrency', event.target.value.toUpperCase())}
                placeholder="USD"
                maxLength={3}
              />
            </div>
          </>
        ) : (
          <div className="control">
            <label htmlFor="program-rate">Rate</label>
            <input
              id="program-rate"
              type="number"
              min="0"
              max="100"
              step="0.01"
              value={asPercent(Number(form.commissionRate ?? 0))}
              onChange={(event) => set('commissionRate', Number(event.target.value) / 100)}
            />
          </div>
        )}
      </div>

      <div className="field-row">
        <div className="control control-grow">
          <label>Earns on</label>
          <div className="channel-actions">
            {Object.entries(REVENUE_COMPONENT_LABELS).map(([component, label]) => (
              <label key={component} className="channel-note">
                <input
                  type="checkbox"
                  checked={(form.revenueComponents ?? []).includes(component)}
                  onChange={() => toggleComponent(component)}
                />{' '}
                {label}
              </label>
            ))}
          </div>
        </div>
        <div className="control">
          <label htmlFor="program-recurrence">Charges</label>
          <select
            id="program-recurrence"
            value={String(form.recurrence ?? 'recurring')}
            onChange={(event) =>
              set('recurrence', event.target.value as ProgramDetail['recurrence'])
            }
            disabled={flat}
          >
            <option value="recurring">Every qualifying charge</option>
            <option value="first_charge_only">The first charge only</option>
          </select>
        </div>
      </div>

      <div className="field-row">
        <div className="control">
          <label htmlFor="program-duration">Duration, months</label>
          <input
            id="program-duration"
            type="number"
            min="1"
            value={form.durationMonths === null ? '' : String(form.durationMonths ?? '')}
            onChange={(event) => set('durationMonths', optionalCount(event.target.value))}
            placeholder="No cut-off"
          />
        </div>
        <div className="control">
          <label htmlFor="program-grace">Release after, days</label>
          <input
            id="program-grace"
            type="number"
            min="0"
            value={
              form.unassignAfterUninstallDays === null
                ? ''
                : String(form.unassignAfterUninstallDays ?? '')
            }
            onChange={(event) =>
              set('unassignAfterUninstallDays', optionalCount(event.target.value))
            }
            placeholder="Never"
          />
        </div>
        <div className="control">
          <label htmlFor="program-floor">Minimum payout</label>
          <input
            id="program-floor"
            type="number"
            min="0"
            step="0.01"
            value={String(form.minimumPayout ?? 0)}
            onChange={(event) => set('minimumPayout', Number(event.target.value))}
          />
        </div>
      </div>

      <div className="field-row">
        <div className="control control-grow">
          <label htmlFor="program-terms">Terms URL</label>
          <input
            id="program-terms"
            value={String(form.termsUrl ?? '')}
            onChange={(event) => set('termsUrl', event.target.value)}
            placeholder="Shown on the signup form, and recorded against each applicant"
          />
        </div>
      </div>

      <div className="channel-actions">
        <label className="channel-note">
          <input
            type="checkbox"
            checked={form.requireApproval === true}
            onChange={(event) => set('requireApproval', event.target.checked)}
          />{' '}
          Applications need approval
        </label>
        <label className="channel-note">
          <input
            type="checkbox"
            checked={form.enforceUnassignAfterUninstall !== false}
            onChange={(event) => set('enforceUnassignAfterUninstall', event.target.checked)}
          />{' '}
          Release referrals after an uninstall
        </label>
      </div>

      <div className="channel-actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : program ? 'Save terms' : 'Create programme'}
        </button>
        {onCancel ? (
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        ) : null}
      </div>

      {error ? <p className="channel-status bad">{error}</p> : null}

      {/*
        The one paragraph on this screen, and it is here because the behaviour
        is the opposite of what a settings form usually does. Saying it after
        the fact — in a toast, or a line in the response — would be telling
        somebody what happened rather than what is about to.
      */}
      {program ? (
        <p className="footnote">
          Saving a rate, a duration or what a programme earns on records a new version effective
          now. Referrals earn the new terms from here on; commissions already earned keep the terms
          they were computed under. Correcting the past is a separate action and is refused once a
          commission has been paid.
        </p>
      ) : null}
    </form>
  );
}
