import { useEffect, useState } from 'react';
import { fetchAffiliateSetup, type AffiliateSetup } from '../api';
import { Stat } from './AffiliateCommon';

/**
 * What state this programme is in, at the top of the affiliate section.
 *
 * The one screen in this product allowed to be instructional, and it is here
 * because of what a fresh install used to see: five affiliate pages, five
 * variations of "no X yet", and one of them pointing at an import that will
 * never run. Every one of those screens was written for a deployment that
 * already had hundreds of affiliates, and read as broken to one that had none.
 *
 * It is figures first even so. Four counts, an attribution mode, and at most
 * one sentence — and the sentence only appears for a step that is genuinely not
 * done. Once the programme can earn, the whole card is gone: a checklist that
 * stays after it is satisfied is a nag, and the operator learns to scroll past
 * the place real information appears.
 *
 * Nothing here is a warning. Manual attribution is not a degraded mode, it is
 * how 214 of this deployment's own 518 migrated referrals were created, so the
 * source is reported as a value and never as a problem.
 */

/** One unfinished step: what is missing, and where to go. */
interface Step {
  label: string;
  detail: string;
  href: string;
}

function stepsFor(setup: AffiliateSetup): Step[] {
  const steps: Step[] = [];

  if (setup.activePrograms === 0) {
    steps.push({
      label: 'Create a programme',
      detail: 'A programme holds the rate, what it earns on, and how long a referral runs.',
      href: '#/affiliate-programs',
    });
    // Everything below depends on a programme existing, so it is the only step
    // shown until there is one. A list of four things you cannot do yet is a
    // worse answer than the one thing you can.
    return steps;
  }

  if (setup.programsWithListing === 0) {
    steps.push({
      label: 'Point it at a listing',
      detail: 'Referral links have nowhere to send a click until a programme has a listing URL.',
      href: '#/affiliate-programs',
    });
  }

  if (setup.enrolledAffiliates === 0) {
    steps.push({
      label: 'Add an affiliate',
      detail: 'Creating one enrols them and mints their referral link.',
      href: '#/affiliates',
    });
  }

  if (setup.portalBaseUrl === '') {
    steps.push({
      label: 'Set PORTAL_BASE_URL',
      detail:
        'Without it a set-password link is site-relative — fine when pasted, broken when emailed.',
      href: '#/affiliates',
    });
  }

  return steps;
}

export function AffiliateSetupCard() {
  const [setup, setSetup] = useState<AffiliateSetup | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAffiliateSetup()
      .then((result) => {
        if (!cancelled) setSetup(result.setup);
      })
      // Silent: this card is a convenience over other pages' own data, and a
      // failure here must not put an error banner above screens that loaded.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!setup || !setup.incomplete) return null;

  const steps = stepsFor(setup);

  return (
    <section className="card full">
      <div className="card-head">
        <span className="card-label">Programme setup</span>
        <span className="card-subtitle">
          {setup.attribution === 'ga4'
            ? `GA4 attribution on ${setup.attributionApps} app${setup.attributionApps === 1 ? '' : 's'}`
            : 'Manual attribution'}
        </span>
      </div>

      <div className="stat-row">
        <Stat
          label="Programmes"
          value={setup.activePrograms.toLocaleString()}
          note={setup.programs > setup.activePrograms ? `${setup.programs} in total` : null}
        />
        <Stat
          label="Affiliates"
          value={setup.enrolledAffiliates.toLocaleString()}
          note={setup.affiliates > setup.enrolledAffiliates ? `${setup.affiliates} on record` : null}
        />
        <Stat
          label="Listings mapped"
          value={setup.programsWithListing.toLocaleString()}
          note={setup.activePrograms > 0 ? `of ${setup.activePrograms} active` : null}
        />
        <Stat label="Invitations" value={setup.emailEnabled ? 'Emailed' : 'Copy the link'} />
      </div>

      {steps.length > 0 ? (
        <ul className="portal-terms">
          {steps.map((step) => (
            <li key={step.label}>
              <a href={step.href}>{step.label}</a> — {step.detail}
            </li>
          ))}
        </ul>
      ) : null}

      {setup.attribution === 'manual' ? (
        <p className="footnote">
          No GA4 export is connected, so installs are credited when you assign them or approve a
          claim. That is a supported way to run a programme; connect BigQuery to have referrals
          credited automatically as well.
        </p>
      ) : null}
    </section>
  );
}
