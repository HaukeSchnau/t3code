import {
  THREAD_ASK_LIMIT,
  type MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type RunId,
  type ThreadAsk,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isUserReply } from "./userTurn.ts";

export type ThreadAskCommand = Extract<
  OrchestrationV2ServerCommand,
  {
    readonly type:
      | "thread.ask.raise"
      | "thread.ask.withdraw"
      | "thread.ask.dismiss"
      | "thread.ask.remind";
  }
>;

type AskRun = Pick<OrchestrationV2Run, "id" | "status" | "completedAt">;

/** Keeps every open ask and only the newest resolved ones. */
function trimAsks(asks: ReadonlyArray<ThreadAsk>): Array<ThreadAsk> {
  let resolvedBudget = THREAD_ASK_LIMIT - asks.filter((ask) => ask.status === "open").length;
  const kept: Array<ThreadAsk> = [];
  for (const ask of asks.toReversed()) {
    if (ask.status !== "open") {
      if (resolvedBudget <= 0) continue;
      resolvedBudget -= 1;
    }
    kept.push(ask);
  }
  return kept.toReversed();
}

const resolve = (
  ask: ThreadAsk,
  status: Exclude<ThreadAsk["status"], "open">,
  now: DateTime.Utc,
): ThreadAsk => ({ ...ask, status, resolvedAt: DateTime.formatIso(now) });

/**
 * Applies an ask command to the thread. A command with nothing to change returns the thread
 * itself, so a late detector, a repeated dismiss, or a withdraw of a resolved ask is a no-op.
 */
export function decideThreadAskCommand(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly command: ThreadAskCommand;
  readonly now: DateTime.Utc;
  /** Only a `turn_end` raise reads these: its run, and the runs of the thread's `turn_end` asks. */
  readonly runs: ReadonlyArray<AskRun>;
  /** When the user's latest reply arrived (`ProjectionStore.getLatestUserReply`). */
  readonly latestUserReplyAt: DateTime.Utc | null;
}): OrchestrationV2AppThread {
  const { thread, command, now } = input;
  const asks = thread.asks ?? [];
  const withAsks = (next: ReadonlyArray<ThreadAsk>) => ({
    ...thread,
    asks: trimAsks(next),
    updatedAt: now,
  });

  switch (command.type) {
    case "thread.ask.raise": {
      if (thread.archivedAt !== null || thread.deletedAt !== null) return thread;
      const source = command.source;
      const raised: ThreadAsk = {
        id: command.askId,
        source,
        text: command.text,
        raisedAt: DateTime.formatIso(now),
        status: "open",
      };
      let next: Array<ThreadAsk>;
      if (source.type === "page") {
        const open = asks.find(
          (ask) =>
            ask.status === "open" &&
            ask.source.type === "page" &&
            ask.source.renderId === source.renderId,
        );
        if (open !== undefined) {
          return open.text === command.text
            ? thread
            : withAsks(asks.map((ask) => (ask === open ? { ...ask, text: command.text } : ask)));
        }
        next = [...asks, raised];
      } else {
        const endedAt = (runId: RunId) =>
          input.runs.find((run) => run.id === runId && run.status === "completed")?.completedAt ??
          null;
        const ended = endedAt(source.runId);
        if (ended === null) return thread;
        // Queued runs can finish out of order, so completion and arrival times decide, not ordinals.
        const after = (at: DateTime.Utc | null) => at !== null && DateTime.isGreaterThan(at, ended);
        if (
          after(input.latestUserReplyAt) ||
          // Once for each run, and never under an ask of a run that ended later, in any status.
          asks.some(
            (ask) =>
              ask.source.type === "turn_end" &&
              (ask.source.runId === source.runId || after(endedAt(ask.source.runId))),
          )
        ) {
          return thread;
        }
        const open = asks.find((ask) => ask.status === "open" && ask.source.type === "turn_end");
        next = [...asks.map((ask) => (ask === open ? resolve(ask, "replaced", now) : ask)), raised];
      }
      // A new ask needs the user, so a settled thread comes back as a new message brings it.
      return thread.settledOverride === "settled"
        ? {
            ...withAsks(next),
            settledOverride: null,
            settledAt: null,
            unsettledAt: now,
          }
        : withAsks(next);
    }
    case "thread.ask.withdraw": {
      const open = asks.find(
        (ask) =>
          ask.status === "open" &&
          ask.source.type === "page" &&
          ask.source.renderId === command.renderId,
      );
      return open === undefined
        ? thread
        : withAsks(asks.map((ask) => (ask === open ? resolve(ask, "withdrawn", now) : ask)));
    }
    case "thread.ask.dismiss": {
      const dismissed = (ask: ThreadAsk) =>
        ask.status === "open" && (command.askId === undefined || ask.id === command.askId);
      return asks.some(dismissed)
        ? withAsks(asks.map((ask) => (dismissed(ask) ? resolve(ask, "dismissed", now) : ask)))
        : thread;
    }
    case "thread.ask.remind": {
      const open = asks.find(
        (ask) => ask.id === command.askId && ask.status === "open" && ask.remindedAt === undefined,
      );
      return open === undefined
        ? thread
        : withAsks(
            asks.map((ask) =>
              ask === open ? { ...ask, remindedAt: DateTime.formatIso(now) } : ask,
            ),
          );
    }
  }
}

/** Settling a thread ends its open asks. */
export function dismissOpenAsks(
  asks: ReadonlyArray<ThreadAsk>,
  now: DateTime.Utc,
): ReadonlyArray<ThreadAsk> {
  return asks.some((ask) => ask.status === "open")
    ? asks.map((ask) => (ask.status === "open" ? resolve(ask, "dismissed", now) : ask))
    : asks;
}

/** A user-authored message answers every open ask of its thread. */
export function threadAfterUserReply(
  thread: OrchestrationV2AppThread,
  messageId: MessageId,
  now: DateTime.Utc,
): OrchestrationV2AppThread {
  const asks = thread.asks ?? [];
  if (!asks.some((ask) => ask.status === "open")) return thread;
  return {
    ...thread,
    asks: trimAsks(
      asks.map((ask) =>
        ask.status === "open" ? { ...resolve(ask, "answered", now), answeredBy: messageId } : ask,
      ),
    ),
    updatedAt: now,
  };
}

type ReplyMessage = Parameters<typeof isUserReply>[0] &
  Pick<OrchestrationV2ConversationMessage, "id" | "runId" | "createdAt">;

/**
 * The user cancelled a queued reply, so the agent never got it. Each ask it answered passes to the
 * user's next reply after that ask, or opens again without one. An ask stays as it is when a newer
 * ask, in any status, took the same place meanwhile.
 */
export function threadAfterCancelledReply(
  thread: OrchestrationV2AppThread,
  messageId: MessageId,
  now: DateTime.Utc,
  /** The thread's user messages and runs, read before the cancellation. */
  transcript: {
    readonly messages: ReadonlyArray<ReplyMessage>;
    readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "startedAt">>;
  },
): OrchestrationV2AppThread {
  const asks = thread.asks ?? [];
  if (!asks.some((ask) => ask.status === "answered" && ask.answeredBy === messageId)) {
    return thread;
  }
  const sameSlot = (left: ThreadAsk, right: ThreadAsk) =>
    left.source.type === "turn_end"
      ? right.source.type === "turn_end"
      : right.source.type === "page" && right.source.renderId === left.source.renderId;
  // The rule of `ProjectionStore.getLatestUserReply`: a send cancelled before it ran is no reply.
  const replies = transcript.messages
    .filter((message) => {
      if (message.id === messageId || !isUserReply(message)) return false;
      const run = transcript.runs.find((candidate) => candidate.id === message.runId);
      return !(run?.status === "cancelled" && run.startedAt === null);
    })
    .toSorted((left, right) => DateTime.Order(left.createdAt, right.createdAt));
  let changed = false;
  const next = asks.map((ask, index): ThreadAsk => {
    if (ask.status !== "answered" || ask.answeredBy !== messageId) return ask;
    // Asks are kept in the order they were raised.
    if (asks.slice(index + 1).some((other) => sameSlot(ask, other))) return ask;
    changed = true;
    const raisedAt = DateTime.makeUnsafe(ask.raisedAt);
    const reply = replies.find((message) => DateTime.isGreaterThan(message.createdAt, raisedAt));
    if (reply !== undefined) return { ...ask, answeredBy: reply.id };
    const { resolvedAt: _resolvedAt, answeredBy: _answeredBy, ...open } = ask;
    return { ...open, status: "open" };
  });
  return changed ? { ...thread, asks: next, updatedAt: now } : thread;
}
