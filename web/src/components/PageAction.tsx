import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Where a page's primary action goes.
 *
 * The shell draws the page header — the title, the subtitle — and only the page
 * itself knows what its primary action is, so the two have to meet somewhere.
 * The header keeps a slot on its own line, at the right; a page declares its
 * action wherever it likes in its own tree and it lands there.
 *
 * A portal rather than a prop threaded through the router: the action is often
 * decided several components deep — by a list that knows whether it is showing
 * rows or a form — and passing a `ReactNode` up through that is how a page ends
 * up rendering its own button under the title instead, which is what a page has
 * to do today.
 *
 * The slot element does not exist on the shell's first render — a DOM node is
 * only there after the commit — so the context holds `null` for exactly one
 * pass and the portal renders nothing. The ref callback then sets it and the
 * action appears in the same frame the page's own content does.
 */
export const PageActionSlot = createContext<HTMLElement | null>(null);

export function PageAction({ children }: { children: ReactNode }) {
  const slot = useContext(PageActionSlot);
  return slot ? createPortal(children, slot) : null;
}
