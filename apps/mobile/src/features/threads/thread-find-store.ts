import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

/** A thread search hit that find selects once its thread is open. */
export interface ThreadFindHit {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly query: string;
}

export const threadFindHitAtom = Atom.make<ThreadFindHit | null>(null).pipe(Atom.keepAlive);

/** Opens find on a thread search hit once its thread shows. */
export function openThreadFindAtHit(match: EnvironmentThreadSearchMatch, query: string) {
  const trimmed = query.trim();
  if (match.messageId === undefined || trimmed.length === 0) return;
  appAtomRegistry.set(threadFindHitAtom, {
    environmentId: match.environmentId,
    threadId: match.threadId,
    messageId: match.messageId,
    query: trimmed,
  });
}

export function clearThreadFindHit() {
  appAtomRegistry.set(threadFindHitAtom, null);
}

/** Drops a hit for one thread, leaving a hit just picked for another in place. */
export function clearThreadFindHitFor(environmentId: EnvironmentId, threadId: ThreadId) {
  const hit = appAtomRegistry.get(threadFindHitAtom);
  if (hit?.environmentId === environmentId && hit.threadId === threadId) clearThreadFindHit();
}
