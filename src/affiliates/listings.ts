/**
 * The link an affiliate shares, as an absolute App Store URL.
 *
 * Absolute because it is meant to be pasted into a blog post or a video
 * description, where a link back through this server's `/r/:handle` would add a
 * hop that this server has to be reachable for. The redirect route still exists
 * and still works — it is what every already-published link uses — but a link
 * handed out today may as well point straight at the listing.
 *
 * There is deliberately no function here that *guesses* a listing. This file
 * used to carry a table of slugs matched against program names, as a floor
 * under `app_listings` and `affiliate_programs.listing_url` for the days after
 * an import when neither is filled in yet. It was removed because the failure
 * is silent and it is the worst kind: a guessed slug either 404s or, if two
 * programs are close enough in name, sends a visitor to install somebody else's
 * app and then attributes that install to an affiliate who did not earn it. A
 * link that cannot be resolved is a 404 and a log line, which is recoverable;
 * a link resolved to the wrong app is not.
 */
export function listingReferralUrl(listingUrl: string, handle: string): string {
  const target = new URL(listingUrl);
  target.searchParams.set('mref', handle);
  return target.toString();
}
