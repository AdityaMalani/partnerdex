import { useState } from 'react';

/**
 * The referral link, and the one interaction the portal really needs.
 *
 * The URL arrives relative (`/r/<handle>`) and is resolved against whatever host
 * the portal is being served from, because the server does not know its own
 * public name and a link built from a guess is a link that stops working behind
 * a proxy.
 */

/**
 * Resolve a link the server handed us, and refuse anything that is not a web
 * address.
 *
 * The handle inside the URL comes from an external system, so the string is not
 * ours even though the route that built it is. `new URL` is the parser the
 * browser will use anyway; checking the protocol it resolves to is what stops a
 * `javascript:` or `data:` value ever reaching an `href`. A value that fails
 * either check is dropped rather than shown broken — see the callers, which
 * treat `null` as "no link yet".
 */
export function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const resolved = new URL(url, window.location.origin);
    if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

export function ReferralLink({ url, label }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const absolute = safeUrl(url);

  if (!absolute) return null;

  const copy = () => {
    navigator.clipboard
      .writeText(absolute)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      // A clipboard write can be refused outright by the browser. The link is on
      // screen and selectable either way, so the failure is survivable and
      // saying nothing beats an alert about permissions.
      .catch(() => undefined);
  };

  return (
    <div className="portal-link">
      <code>{absolute}</code>
      <button type="button" onClick={copy} aria-label={label ? `Copy ${label} link` : 'Copy link'}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
