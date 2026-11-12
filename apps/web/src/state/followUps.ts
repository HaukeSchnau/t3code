import { useAtomValue } from "@effect/atom-react";
import {
  createFollowUpEnvironmentAtoms,
  type FollowUpHome,
  followUpHomes,
  returnedFollowUps,
} from "@t3tools/client-runtime/state/follow-ups";
import type { EnvironmentId, FollowUp, FollowUpsSubscribeInput } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentAtomList } from "./environmentAtomList";
import { environmentSummaries } from "./presentation";
import { serverEnvironment } from "./server";

/** Follow-ups (patches/follow-ups.md). */
export const followUpEnvironment = createFollowUpEnvironmentAtoms(connectionAtomRuntime);

// The inbox and the page read the same open-only subscription.
const OPEN_FOLLOW_UPS: FollowUpsSubscribeInput = {};
const ALL_FOLLOW_UPS: FollowUpsSubscribeInput = { includeClosed: true };

export const openFollowUpSnapshotsAtom = environmentAtomList(
  "web-follow-ups-open",
  (environmentId) => followUpEnvironment.snapshot({ environmentId, input: OPEN_FOLLOW_UPS }),
);

export const allFollowUpSnapshotsAtom = environmentAtomList("web-follow-ups-all", (environmentId) =>
  followUpEnvironment.snapshot({ environmentId, input: ALL_FOLLOW_UPS }),
);

/** The stores the connected environments use, so the active environment mode picks them. */
export const followUpHomesAtom = Atom.make((get) => {
  const next = followUpHomes(
    get(environmentSummaries.connectedEnvironmentIdsAtom).flatMap((environmentId) => {
      // Servers without follow-ups name no home.
      const followUpHome = get(serverEnvironment.configValueAtom(environmentId))?.followUpHome;
      return followUpHome === undefined ? [] : [{ environmentId, followUpHome }];
    }),
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<FollowUpHome>>());
  return previous !== null &&
    previous.length === next.length &&
    next.every(
      (home, index) =>
        home.environmentId === previous[index]!.environmentId &&
        home.connected === previous[index]!.connected,
    )
    ? previous
    : next;
}).pipe(Atom.withLabel("web-follow-up-homes"));

/** Where a thread's environment saves follow-ups: the home it names, else itself. */
export const followUpHomeOfAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): EnvironmentId =>
      get(serverEnvironment.configValueAtom(environmentId))?.followUpHome ?? environmentId,
  ).pipe(Atom.withLabel(`web-follow-up-home-of:${environmentId}`)),
);

function followUpRowKey(homeEnvironmentId: EnvironmentId, followUp: Pick<FollowUp, "id">) {
  return `follow-up:${homeEnvironmentId}:${followUp.id}`;
}

export interface InboxFollowUp {
  readonly key: string;
  readonly followUp: FollowUp;
  readonly returnedAtMs: number;
}

/** Returned follow-ups from every connected home, newest return first: the inbox rows. */
const inboxFollowUpsAtom = Atom.make((get) => {
  const next = get(followUpHomesAtom)
    .flatMap((home): InboxFollowUp[] => {
      if (!home.connected) return [];
      const snapshot = AsyncResult.getOrElse(
        get(
          followUpEnvironment.snapshot({
            environmentId: home.environmentId,
            input: OPEN_FOLLOW_UPS,
          }),
        ),
        () => null,
      );
      return (snapshot === null ? [] : returnedFollowUps(snapshot.followUps)).map((followUp) => ({
        key: followUpRowKey(home.environmentId, followUp),
        followUp,
        returnedAtMs: Date.parse(followUp.returnedAt ?? ""),
      }));
    })
    .sort((left, right) => right.returnedAtMs - left.returnedAtMs);
  // Each snapshot decodes fresh objects; keep the list while no row changed.
  const previous = Option.getOrNull(get.self<ReadonlyArray<InboxFollowUp>>());
  return previous !== null &&
    previous.length === next.length &&
    next.every(
      (row, index) =>
        row.key === previous[index]!.key &&
        row.followUp.updatedAt === previous[index]!.followUp.updatedAt,
    )
    ? previous
    : next;
}).pipe(Atom.withLabel("web-inbox-follow-ups"));

export function useInboxFollowUps(): ReadonlyArray<InboxFollowUp> {
  return useAtomValue(inboxFollowUpsAtom);
}
