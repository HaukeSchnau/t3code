import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface HtmlRenderOpenTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly renderId: string;
}

// The page's frame owns its full-screen dialog and the bridge the page answers through, so a
// control outside the frame (the thread's ask line) asks the frame to open. A request for a frame
// the timeline has not mounted yet waits until it scrolls into view and registers.
const openers = new Map<string, () => void>();
let pending: string | null = null;

const keyOf = (target: HtmlRenderOpenTarget) =>
  `${target.environmentId}\u0000${target.threadId}\u0000${target.renderId}`;

export function requestHtmlRenderOpen(target: HtmlRenderOpenTarget): void {
  const key = keyOf(target);
  const open = openers.get(key);
  pending = open === undefined ? key : null;
  open?.();
}

/** Registers the frame that shows a page; it opens at once when a request waits for it. */
export function registerHtmlRenderOpener(
  target: HtmlRenderOpenTarget,
  open: () => void,
): () => void {
  const key = keyOf(target);
  openers.set(key, open);
  if (pending === key) {
    pending = null;
    // A frame that remounts before the microtask replaces this registration; open that one.
    queueMicrotask(() => openers.get(key)?.());
  }
  return () => {
    if (openers.get(key) === open) openers.delete(key);
  };
}
