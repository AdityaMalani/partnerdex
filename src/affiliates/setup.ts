import { getConfig } from '../config.js';
import { getDb, type Db } from '../db/index.js';

/**
 * What state is this affiliate programme actually in?
 *
 * This exists because the path nobody had ever walked was the first one. A
 * fresh install opened five affiliate pages and got five variations of "no X
 * yet" — one of which pointed at an import that will never run — with no
 * control on any of them. Every screen was built for a deployment that already
 * had 614 affiliates and two programmes, and read as broken to one that had
 * neither.
 *
 * The answer is not a wizard. A wizard is a mode you are either in or out of,
 * and it goes stale the moment somebody does half of it from the API. This is a
 * *reading* of the database taken fresh on every request: four questions, each
 * answered by a count or a value, and the card that renders it disappears on
 * its own once the programme is genuinely running. A checklist that never goes
 * away is a nag, not a state.
 *
 * ## Why GA4 is a value here and not a warning
 *
 * Attribution already degrades correctly without BigQuery — `attributeReferrals`
 * returns empty, the sync carries on, and the recompute still runs so existing
 * referrals keep earning through an outage. What was missing is that nobody was
 * ever *told*. An instance where attribution is running and finding nothing
 * looks exactly like one where it is not running at all.
 *
 * So the source is reported as a value — `ga4` or `manual` — and manual is not
 * an error state. It is a supported way to run a programme: an operator assigns
 * referrals by hand, or affiliates file claims and an operator approves them,
 * and both of those paths are first-class. 214 of this deployment's own 518
 * migrated referrals were created by hand.
 */

export type AttributionSource = 'ga4' | 'manual';

export interface AffiliateSetupState {
  /** Programmes that exist at all, and those an affiliate could join today. */
  programs: number;
  activePrograms: number;
  /** Programmes with somewhere for a referral link to send a click. */
  programsWithListing: number;
  affiliates: number;
  /** Affiliates who can actually earn — enrolled in something. */
  enrolledAffiliates: number;
  attribution: AttributionSource;
  /** Apps with a GA4 dataset mapped, when BigQuery is connected. */
  attributionApps: number;
  /**
   * The origin set-password and referral links are built against, or empty.
   *
   * Deployment configuration rather than programme configuration, and reported
   * here because it is the one setting whose absence is invisible until an
   * affiliate receives a link that does not work.
   */
  portalBaseUrl: string;
  /** Whether a mail relay is configured, so invitations can be sent. */
  emailEnabled: boolean;
  /**
   * Whether the affiliate section still has anything to tell the operator.
   *
   * False once a programme exists, is active, has somewhere to send a click,
   * and has at least one affiliate enrolled in it — which is the definition of
   * "this programme can earn money", and the point at which the setup card has
   * nothing left to say.
   */
  incomplete: boolean;
}

function count(db: Db, sql: string): number {
  const row = db.prepare(sql).get() as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function affiliateSetupState(db: Db = getDb()): AffiliateSetupState {
  const programs = count(db, 'SELECT COUNT(*) AS n FROM affiliate_programs');
  const activePrograms = count(
    db,
    `SELECT COUNT(*) AS n FROM affiliate_programs WHERE status = 'active'`,
  );

  /*
   * A programme has somewhere to send a click if either source resolves, in the
   * precedence the redirect itself follows: `app_listings.url` first — the
   * operator's own mapping — then the programme's own `listing_url`. Asking the
   * same question a different way here is how this card ends up reporting a
   * programme as ready that the redirect 404s.
   */
  const programsWithListing = count(
    db,
    `SELECT COUNT(*) AS n FROM affiliate_programs p
      WHERE p.status = 'active'
        AND (p.listing_url <> ''
             OR EXISTS (SELECT 1 FROM app_listings l
                         WHERE l.app_id = p.app_id AND p.app_id <> '' AND l.url <> ''))`,
  );

  const affiliates = count(db, `SELECT COUNT(*) AS n FROM affiliates WHERE status = 'active'`);
  const enrolledAffiliates = count(
    db,
    `SELECT COUNT(DISTINCT m.affiliate_id) AS n
       FROM affiliate_memberships m
       JOIN affiliates a ON a.id = m.affiliate_id
       JOIN affiliate_programs p ON p.id = m.program_id
      WHERE m.status = 'enrolled' AND a.status = 'active' AND p.status = 'active'`,
  );

  /*
   * GA4 attribution needs a connection *and* a dataset for at least one app.
   * Either alone attributes nothing: a connection with no datasets queries no
   * tables, and a dataset with no connection has nothing to query with. The
   * pipeline already treats both as a quiet skip, and reporting "connected" off
   * the connection row alone would tell an operator attribution is running when
   * it is skipping every app.
   */
  const connected = count(db, 'SELECT COUNT(*) AS n FROM bigquery_connection') > 0;
  const attributionApps = connected
    ? count(
        db,
        `SELECT COUNT(*) AS n FROM bigquery_app_sources
          WHERE dataset IS NOT NULL AND dataset <> ''`,
      )
    : 0;

  const config = getConfig();

  const ready =
    activePrograms > 0 && programsWithListing > 0 && enrolledAffiliates > 0;

  return {
    programs,
    activePrograms,
    programsWithListing,
    affiliates,
    enrolledAffiliates,
    attribution: attributionApps > 0 ? 'ga4' : 'manual',
    attributionApps,
    portalBaseUrl: config.runtime.portalBaseUrl,
    emailEnabled: config.email.enabled,
    incomplete: !ready,
  };
}
