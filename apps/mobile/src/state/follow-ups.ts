import {
  createFollowUpEnvironmentAtoms,
  followUpHomes,
  returnedFollowUps,
  type FollowUpHome,
} from "@t3tools/client-runtime/state/follow-ups";
import type { EnvironmentId, FollowUp } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { connectedEnvironmentIdsAtom } from "./presentation";
import { serverEnvironment } from "./server";

/** Fork: follow-ups (patches/follow-ups.md). */
export const followUpEnvironment = createFollowUpEnvironmentAtoms(connectionAtomRuntime);

/** One subscription per home serves the tab, the inbox and the detail page while nothing closed is shown. */
export function openFollowUpsAtom(environmentId: EnvironmentId) {
  return followUpEnvironment.snapshot({ environmentId, input: {} });
}

export function allFollowUpsAtom(environmentId: EnvironmentId) {
  return followUpEnvironment.snapshot({ environmentId, input: { includeClosed: true } });
}

/** The homes of the switched-on environments. A server without the feature advertises none. */
export const followUpHomesAtom = Atom.make((get) => {
  const next = followUpHomes(
    get(connectedEnvironmentIdsAtom).flatMap((environmentId) => {
      const followUpHome = get(serverEnvironment.configValueAtom(environmentId))?.followUpHome;
      return followUpHome === undefined ? [] : [{ environmentId, followUpHome }];
    }),
  );
  const previous = Option.getOrUndefined(get.self<ReadonlyArray<FollowUpHome>>());
  // Config pushes for unrelated settings must not resubscribe or rebuild the thread list.
  return previous?.length === next.length &&
    previous.every(
      (home, index) =>
        home.environmentId === next[index]!.environmentId &&
        home.connected === next[index]!.connected,
    )
    ? previous
    : next;
}).pipe(Atom.withLabel("mobile:follow-up-homes"));

export interface InboxFollowUp {
  readonly homeEnvironmentId: EnvironmentId;
  readonly followUp: FollowUp;
}

/** Returned follow-ups across the connected homes, newest return first. */
export const inboxFollowUpsAtom = Atom.make((get) => {
  const next = get(followUpHomesAtom)
    .flatMap((home): ReadonlyArray<InboxFollowUp> => {
      if (!home.connected) return [];
      const snapshot = AsyncResult.getOrElse(
        get(openFollowUpsAtom(home.environmentId)),
        () => null,
      );
      return snapshot === null
        ? []
        : returnedFollowUps(snapshot.followUps).map((followUp) => ({
            homeEnvironmentId: home.environmentId,
            followUp,
          }));
    })
    .sort((left, right) =>
      (right.followUp.returnedAt ?? "").localeCompare(left.followUp.returnedAt ?? ""),
    );
  const previous = Option.getOrUndefined(get.self<ReadonlyArray<InboxFollowUp>>());
  // Every save resends the whole snapshot; only a change to a returned one may rebuild the list.
  return previous?.length === next.length &&
    previous.every(
      (entry, index) =>
        entry.homeEnvironmentId === next[index]!.homeEnvironmentId &&
        entry.followUp.id === next[index]!.followUp.id &&
        entry.followUp.updatedAt === next[index]!.followUp.updatedAt,
    )
    ? previous
    : next;
}).pipe(Atom.withLabel("mobile:inbox-follow-ups"));
