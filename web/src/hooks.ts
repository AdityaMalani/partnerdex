/**
 * The two hooks every searchable, paged list on the dashboard needs.
 *
 * Both existed already — `useDebounced` five times over, copied file to file,
 * and the reset below as an effect that did not quite work. They are here so
 * that a list added tomorrow gets the behaviour rather than the copy.
 */

import { useEffect, useState } from 'react';

/** Waits for the typing to stop before asking the server. */
export function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * Run `reset` during render whenever `key` changes.
 *
 * This is how a list forgets its offset when the reader searches — keeping it
 * would silently show page four of a result set they have not seen page one of
 * — and it is deliberately *not* an effect. An effect runs after the render
 * that changed the filter has already committed, so the fetch beside it goes
 * out once with the old offset and again a moment later with the new one: two
 * requests, and the first is for a page nobody will be shown. Setting state
 * during render makes React discard the render and re-run it before any child
 * or any effect sees it, which is the sanctioned way to adjust state in
 * response to a prop or a sibling piece of state changing.
 *
 * `key` is a string so that a caller can join several filters into one without
 * this hook having to care how many there are.
 */
export function useResetOnChange(key: string, reset: () => void): void {
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    reset();
  }
}
