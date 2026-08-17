import { formatValue } from '../format';
import type { Earnings, Me } from './api';
import { ReferralLink, safeUrl } from './ReferralLink';
import { EarningsSparkline } from './Sparkline';
import { statusCopy } from './terms';
import type { PortalRoute } from './routes';

/**
 * The page an affiliate opens, and usually the only one they read.
 *
 * Figures first, link second. The earlier draft led with the link on the
 * argument that it is the thing an affiliate came to fetch; watching the tab in
 * use said otherwise — the link is fetched once and the balance is checked every
 * month, so the returning reader was scrolling past a control they had already
 * copied to reach the number they came back for. The link is still above the
 * fold on a phone, one row down.
 *
 * Everything that used to be said in a sentence here is either a tile or gone.
 */

const money = (value: number, currency: string): string =>
  formatValue(value, 'money', currency || 'USD');

export function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {note ? <span className="stat-note">{note}</span> : null}
    </div>
  );
}

export function Overview({
  me,
  earnings,
  onNavigate,
}: {
  me: Me;
  earnings: Earnings;
  onNavigate: (route: PortalRoute) => void;
}) {
  const currency = earnings.currency;
  // A link is shown only where the server issued one. `referralUrl` is null for
  // every membership that is not enrolled, which is the rule being relied on
  // here: this page never reconstructs a link from a handle, so a pending
  // affiliate cannot be handed one by a bug on the client.
  const linkable = me.memberships.filter((membership) => safeUrl(membership.referralUrl));
  const waiting = me.memberships.filter((membership) => !membership.referralUrl);
  const noReferrals = earnings.referrals.total === 0;

  return (
    <>
      <div className="portal-stats">
        {/* "Outstanding", not "due": payouts happen outside this system and
            this page cannot promise a date. */}
        <Stat label="Outstanding" value={money(earnings.unpaid, currency)} />
        <Stat label="Earned all time" value={money(earnings.lifetime, currency)} />
        <Stat label="Already paid" value={money(earnings.paid, currency)} />
        <Stat
          label="Merchants referred"
          value={formatValue(earnings.referrals.total, 'count', null)}
          note={
            earnings.referrals.total > 0
              ? `${formatValue(earnings.referrals.active, 'count', null)} still credited`
              : undefined
          }
        />
        {/* A figure, not a paragraph — but only when there is one, because a
            zero here would invite a question nobody had. */}
        {earnings.cancelled > 0 ? (
          <Stat
            label="Withdrawn"
            value={money(earnings.cancelled, currency)}
            note="Refunded charges"
          />
        ) : null}
      </div>

      <EarningsSparkline byMonth={earnings.byMonth} currency={currency} />

      {linkable.length > 0 ? (
        <div className="portal-links">
          {linkable.map((membership) => (
            <div className="portal-link-row" key={membership.membershipId}>
              <span className="stat-label">{membership.program}</span>
              <ReferralLink url={membership.referralUrl as string} label={membership.program} />
            </div>
          ))}
        </div>
      ) : null}

      {/* Membership states that cannot earn. Compressed to one line each, but
          still said outright: a pending affiliate who is not told is a pending
          affiliate promoting a link that credits nobody. */}
      {waiting.map((membership) => {
        const copy = statusCopy(membership.status);
        return (
          <p className="portal-hint portal-note" key={membership.membershipId}>
            <span className={`pill pill-${copy.tone}`}>{copy.label}</span> {membership.program} —{' '}
            {copy.meaning}
          </p>
        );
      })}

      {me.memberships.length === 0 ? (
        <p className="portal-hint portal-note">
          You are not enrolled in a program yet, so there is no link to share. Get in touch and we
          will set you up.
        </p>
      ) : null}

      {noReferrals && linkable.length > 0 ? (
        <p className="portal-hint portal-note">
          No installs through your link yet. Referrals appear here within a day of the install.
        </p>
      ) : null}

      <p className="footnote">
        Payments are made outside this portal.{' '}
        <button type="button" className="link-button" onClick={() => onNavigate('payouts')}>
          See what has been sent
        </button>
        .
      </p>
    </>
  );
}
