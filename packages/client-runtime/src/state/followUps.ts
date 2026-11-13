import {
  type EnvironmentId,
  FOLLOW_UP_WS_METHODS,
  type FollowUp,
  type FollowUpOrigin,
  type FollowUpsSnapshot,
  type FollowUpsSubscribeInput,
  type FollowUpStatus,
} from "@t3tools/contracts";
import { formatFollowUpLink, parseFollowUpLinkHref } from "@t3tools/shared/followUpLinks";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Follow-ups kept by one home environment (patches/follow-ups.md). */
export function createFollowUpEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Open follow-ups, the type registry and the latest gardener run; closed ones on request. */
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:follow-ups:snapshot",
      tag: FOLLOW_UP_WS_METHODS.subscribe,
      idleTtlMs: 60_000,
    }),
    history: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:follow-ups:history",
      tag: FOLLOW_UP_WS_METHODS.history,
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:follow-ups:save",
      tag: FOLLOW_UP_WS_METHODS.save,
    }),
    /** Starts the gardener's nightly pass now; its thread's last message is the report. */
    runGardener: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:follow-ups:run-gardener",
      tag: FOLLOW_UP_WS_METHODS.runGardener,
    }),
  };
}

export interface FollowUpHome {
  readonly environmentId: EnvironmentId;
  /** Whether the client is connected to the home, so it can read its store. */
  readonly connected: boolean;
}

/**
 * The stores the switched-on environments use. Each environment names its home, itself when it
 * keeps its own, so a mode that switches on the personal machines shows the personal store.
 */
export function followUpHomes(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly followUpHome: EnvironmentId | undefined;
  }>,
): ReadonlyArray<FollowUpHome> {
  const connected = new Set(environments.map((environment) => environment.environmentId));
  const homes = new Set<EnvironmentId>();
  for (const environment of environments) {
    homes.add(environment.followUpHome ?? environment.environmentId);
  }
  return [...homes].map((environmentId) => ({
    environmentId,
    connected: connected.has(environmentId),
  }));
}

/** What a link to a follow-up shows. `missing` covers an unreachable home and a deleted one. */
export type LinkedFollowUp =
  | { readonly state: "found"; readonly title: string; readonly status: FollowUpStatus }
  | { readonly state: "loading" }
  | { readonly state: "missing" };

const LINKED_LOADING: LinkedFollowUp = { state: "loading" };
const LINKED_MISSING: LinkedFollowUp = { state: "missing" };

/**
 * Links to follow-ups by href. The home's open list answers most; the closed list loads only for
 * a link the open one lacks. A chip re-renders only when its own title or status changes.
 */
export function createLinkedFollowUpAtomFamily<E>(
  snapshot: (key: {
    readonly environmentId: EnvironmentId;
    readonly input: FollowUpsSubscribeInput;
  }) => Atom.Atom<AsyncResult.AsyncResult<FollowUpsSnapshot, E>>,
  connectedEnvironmentIds: Atom.Atom<ReadonlyArray<EnvironmentId>>,
) {
  return Atom.family((href: string) => {
    const ref = parseFollowUpLinkHref(href);
    return Atom.make((get): LinkedFollowUp => {
      if (ref === null || !get(connectedEnvironmentIds).includes(ref.environmentId)) {
        return LINKED_MISSING;
      }
      const find = (input: FollowUpsSubscribeInput) => {
        const result = get(snapshot({ environmentId: ref.environmentId, input }));
        if (result._tag === "Failure") return LINKED_MISSING;
        if (result._tag === "Initial") return LINKED_LOADING;
        return result.value.followUps.find((followUp) => followUp.id === ref.followUpId) ?? null;
      };
      const found = find({}) ?? find({ includeClosed: true }) ?? LINKED_MISSING;
      if (!("id" in found)) return found;
      const previous = Option.getOrNull(get.self<LinkedFollowUp>());
      return previous?.state === "found" &&
        previous.title === found.title &&
        previous.status === found.status
        ? previous
        : { state: "found", title: found.title, status: found.status };
    }).pipe(Atom.withLabel(`follow-up-link:${href}`));
  });
}

const CLOSED_STATUSES: ReadonlySet<FollowUpStatus> = new Set(["done", "dropped", "merged"]);

export function isFollowUpClosed(followUp: Pick<FollowUp, "status">): boolean {
  return CLOSED_STATUSES.has(followUp.status);
}

/** Dated ones by date, soonest first, then undated ones newest first. */
function compareOpen(left: FollowUp, right: FollowUp): number {
  if (left.dueAt !== null && right.dueAt !== null) return left.dueAt.localeCompare(right.dueAt);
  if (left.dueAt !== null) return -1;
  if (right.dueAt !== null) return 1;
  return right.createdAt.localeCompare(left.createdAt);
}

const newestFirst =
  (time: (followUp: FollowUp) => string | null) => (left: FollowUp, right: FollowUp) =>
    (time(right) ?? "").localeCompare(time(left) ?? "");

/** The follow-ups page's groups, each in the order to act on it. */
export function groupFollowUps(followUps: ReadonlyArray<FollowUp>) {
  return {
    backNow: returnedFollowUps(followUps),
    open: followUps
      .filter((followUp) => followUp.status === "open" && followUp.returnedAt === null)
      .sort(compareOpen),
    pickedUp: followUps
      .filter((followUp) => followUp.status === "picked_up")
      .sort(newestFirst((followUp) => followUp.updatedAt)),
    closed: followUps.filter(isFollowUpClosed).sort(newestFirst((followUp) => followUp.closedAt)),
  };
}

/** Open follow-ups whose date has come, newest return first: the ones the inbox shows. */
export function returnedFollowUps(followUps: ReadonlyArray<FollowUp>): ReadonlyArray<FollowUp> {
  return followUps
    .filter((followUp) => followUp.status === "open" && followUp.returnedAt !== null)
    .sort((left, right) => (right.returnedAt ?? "").localeCompare(left.returnedAt ?? ""));
}

function originThreadLink(origin: FollowUpOrigin): string {
  return formatThreadLink(
    { environmentId: origin.environmentId, threadId: origin.threadId },
    origin.threadTitle ?? undefined,
  );
}

/** The first message of a thread that picks a follow-up up; its link names the home. */
export function followUpSeedMessage(followUp: FollowUp, homeEnvironmentId: EnvironmentId): string {
  const link = formatFollowUpLink(
    { environmentId: homeEnvironmentId, followUpId: followUp.id },
    followUp.title,
  );
  const lines = [`Pick up follow-up ${link}`];
  if (followUp.body.trim() !== "") lines.push("", followUp.body.trim());
  if (followUp.origin !== null) {
    lines.push("", `It came from ${originThreadLink(followUp.origin)}.`);
    if (followUp.origin.quote !== null) {
      lines.push("", ...followUp.origin.quote.split("\n").map((line) => `> ${line}`));
    }
  }
  lines.push(
    "",
    `This thread picked it up. When the work is done, close ${followUp.id} with its result.`,
  );
  return lines.join("\n");
}

/** Where a quick capture goes: the one home in reach, or null when the user has to pick. */
export function captureHome(homes: ReadonlyArray<FollowUpHome>): FollowUpHome | null {
  const connected = homes.filter((home) => home.connected);
  return connected.length === 1 ? connected[0]! : null;
}

/** A captured note becomes a follow-up: its first line the title, all of it the body. */
export function captureToFollowUp(
  text: string,
): { readonly title: string; readonly body: string } | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const firstLine = trimmed.split("\n", 1)[0]!.trim();
  const title = firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 79).trimEnd()}…`;
  return { title, body: trimmed === title ? "" : trimmed };
}
