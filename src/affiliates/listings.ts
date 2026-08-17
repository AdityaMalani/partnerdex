import { LISTING_HOST } from './ga4Attribution.js';

/**
 * Which App Store page each program's links point at, when nobody has said.
 *
 * The real answer is data: `app_listings` when the operator has filled in the
 * App listings page, and `affiliate_programs.listing_url` when the import knew
 * it. This is the floor under both, and it exists because of a timing problem
 * rather than a design preference — the affiliate import lands hundreds of live
 * referral links on day one, and a program whose app has not synced yet has no listing
 * mapped to it from any other direction. Without a floor, every one of those
 * links is dead on the day it matters most.
 *
 * Two programs, two slugs, matched on the program or app name. Small enough to
 * be obviously right, and it stops applying the moment a listing is stored — see
 * the order `listingUrlForProgram` reads them in.
 *
 * Mantle's own `app.slug` is deliberately not used: it says `restock-rocket`,
 * which is Mantle's handle for the app and not the App Store listing's, and
 * following it would send every Stoq click to a page that does not exist.
 */
const KNOWN_LISTINGS: Array<{ match: RegExp; handle: string }> = [
  { match: /stoq/i, handle: 'back-in-stock-restock-alerts' },
  { match: /filemonk/i, handle: 'filemonk' },
];

/** The listing URL for a program or app name, or blank if it names neither. */
export function knownListingUrl(name: string): string {
  const listing = KNOWN_LISTINGS.find((entry) => entry.match.test(name));
  return listing ? `https://${LISTING_HOST}/${listing.handle}` : '';
}

/**
 * The link an affiliate shares, as an absolute App Store URL.
 *
 * Absolute because it is meant to be pasted into a blog post or a YouTube
 * description, where a link back through this server's `/r/:handle` would add a
 * hop that this server has to be reachable for. The redirect route still exists
 * and still works — it is what every already-published link uses — but a link we
 * hand out today may as well point straight at the listing.
 */
export function listingReferralUrl(listingUrl: string, handle: string): string {
  const target = new URL(listingUrl);
  target.searchParams.set('mref', handle);
  return target.toString();
}
