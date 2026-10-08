import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import type { ThreadFindScope } from "@t3tools/client-runtime/thread-find";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";

export interface ThreadFindPreferences {
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
  readonly scope: ThreadFindScope;
}

/** Shared by every thread, so find reopens with the last query wherever the reader goes. */
export const threadFindPreferencesAtom = Atom.make<ThreadFindPreferences>({
  query: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  scope: "all",
}).pipe(Atom.keepAlive);

/** The reader's own edit, which supersedes a pending thread search hit. */
export function updateThreadFindPreferences(patch: Partial<ThreadFindPreferences>) {
  appAtomRegistry.set(threadFindPreferencesAtom, {
    ...appAtomRegistry.get(threadFindPreferencesAtom),
    ...patch,
  });
  clearThreadFindHit();
}

/** A query handed from in-thread find to the thread list search, consumed once. */
export const threadSearchHandoffAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive);

export function handOffThreadSearch(query: string) {
  appAtomRegistry.set(threadSearchHandoffAtom, query);
}

export function takeThreadSearchHandoff(): string | null {
  const query = appAtomRegistry.get(threadSearchHandoffAtom);
  if (query !== null) appAtomRegistry.set(threadSearchHandoffAtom, null);
  return query;
}

/** A thread search hit that find selects once its thread is open. */
export interface ThreadFindHit {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly query: string;
}

export const threadFindHitAtom = Atom.make<ThreadFindHit | null>(null).pipe(Atom.keepAlive);

/**
 * Opens find on a thread search hit once its thread shows. Thread search
 * matches literal text in any role and ignores case, so options that could
 * hide the hit reset, and the query is lowercased so smart case stays off.
 */
export function openThreadFindAtHit(match: EnvironmentThreadSearchMatch, query: string) {
  if (match.messageId === undefined) return;
  const lowered = query.trim().toLowerCase();
  appAtomRegistry.set(threadFindPreferencesAtom, {
    query: lowered,
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    scope: "all",
  });
  appAtomRegistry.set(threadFindHitAtom, {
    environmentId: match.environmentId,
    threadId: match.threadId,
    messageId: match.messageId,
    query: lowered,
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
