// Fork: notification replies and the Apple Watch. See patches/notification-replies.md and
// patches/apple-watch.md.
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2UserInputQuestion,
  type ThreadGlance,
  type ThreadGlanceList,
  type ThreadGlanceRow,
  ThreadId,
  type ThreadReplyResult,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export class ThreadControlThreadNotFoundError extends Schema.TaggedError<ThreadControlThreadNotFoundError>()(
  "ThreadControlThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found.`;
  }
}

export class ThreadControlReplyRejectedError extends Schema.TaggedError<ThreadControlReplyRejectedError>()(
  "ThreadControlReplyRejectedError",
  { threadId: ThreadId, commandId: CommandId },
) {
  override get message(): string {
    return `The server rejected reply ${this.commandId} earlier.`;
  }
}

type ReadError =
  | ThreadControlThreadNotFoundError
  | Orchestrator.OrchestratorV2Error
  | ProjectStore.ProjectStoreV2Error;
type DispatchError =
  | ReadError
  | ThreadManagement.ThreadManagementProviderInstanceDisabledError
  | CommandReceiptStore.CommandReceiptStoreV2Error
  | ThreadControlReplyRejectedError;

export class ThreadControl extends Context.Service<
  ThreadControl,
  {
    /**
     * Decides what a free-text reply means: the answer to a single pending question, or the
     * thread's next message. Retries with the same `replyId` deliver at most once.
     */
    readonly reply: (input: {
      readonly threadId: ThreadId;
      readonly replyId: string;
      readonly text: string;
    }) => Effect.Effect<ThreadReplyResult, DispatchError>;
    /** Stops the thread the way the app's Stop button does. */
    readonly stop: (threadId: ThreadId) => Effect.Effect<void, DispatchError>;
    readonly listGlances: () => Effect.Effect<ThreadGlanceList, ReadError>;
    readonly getGlance: (threadId: ThreadId) => Effect.Effect<ThreadGlance, ReadError>;
  }
>()("t3/threadControl/ThreadControl") {}

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_RECENT_ROWS = 20;
const EXCERPT_LIMIT = 280;

type Phase = ThreadGlanceRow["phase"];
const isFinished = (phase: Phase) => phase === "completed" || phase === "failed";

// Attention first, then failures, then work in flight, then finished work.
function phaseRank(phase: Phase): number {
  switch (phase) {
    case "waiting_for_approval":
    case "waiting_for_input":
      return 0;
    case "failed":
      return 1;
    case "starting":
    case "running":
      return 2;
    default:
      return 3;
  }
}

/** Retries of one reply share these ids, which makes them idempotent. */
const threadReplyCommandId = (replyId: string) => CommandId.make(`thread-reply:${replyId}`);
const threadReplyMessageId = (replyId: string) => MessageId.make(`thread-reply:${replyId}`);

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const crypto = yield* Crypto.Crypto;

  const readShell = Effect.fn("ThreadControl.readShell")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId);
    if (shell === null || shell.deletedAt !== null) {
      return yield* new ThreadControlThreadNotFoundError({ threadId });
    }
    return shell;
  });

  /**
   * What a notification or the watch can do about the thread's pending runtime requests: nothing
   * pending, an approval (which needs the app), several questions or a multi-part one (which need
   * the full client), or exactly one single-part question it can answer. The shell summarizes
   * only the newest request, so every pending one is read.
   */
  const pendingReplyTarget = Effect.fn("ThreadControl.pendingReplyTarget")(function* (
    shell: OrchestrationV2ThreadShell,
  ) {
    const { runtimeRequests, turnItems } = yield* threads.getThreadRecords(
      shell.id,
      ["runtimeRequests", "turnItems"],
      { turnItemTypes: ["user_input_request"] },
    );
    const pending = runtimeRequests.filter(
      (request) => request.status === "pending" && request.kind !== "auth_refresh",
    );
    if (pending.length === 0) return { kind: "none" } as const;
    if (pending.some((request) => request.kind !== "user_input")) {
      return { kind: "approval" } as const;
    }
    const [request] = pending;
    const item = turnItems.find(
      (candidate) => candidate.type === "user_input_request" && candidate.requestId === request!.id,
    );
    if (pending.length !== 1 || item?.type !== "user_input_request" || item.questions.length !== 1)
      return { kind: "needs_client" } as const;
    return { kind: "question", requestId: request!.id, question: item.questions[0]! } as const;
  });

  // Shell rows never carry message bodies, so the excerpt comes from the latest run's messages.
  const latestAgentExcerpt = Effect.fn("ThreadControl.latestAgentExcerpt")(function* (
    shell: OrchestrationV2ThreadShell,
  ) {
    if (shell.latestRunId === null) return undefined;
    const { messages } = yield* threads.getThreadRecords(shell.id, ["messages"], {
      messageRoles: ["assistant"],
      messageRunIds: [shell.latestRunId],
    });
    const text = messages.findLast((message) => message.text.trim() !== "")?.text;
    return text === undefined ? undefined : glanceExcerpt(text);
  });

  const reply: ThreadControl["Service"]["reply"] = Effect.fn("ThreadControl.reply")(
    function* (input) {
      const commandId = threadReplyCommandId(input.replyId);
      // A retry after a lost response finds the first attempt's receipt. This check comes first
      // because the answered question is gone by now, so planning again would decide differently.
      const receipt = yield* receipts.getByCommandId(commandId);
      if (Option.isSome(receipt)) {
        if (receipt.value.status === "accepted") return { outcome: "already_delivered" } as const;
        return yield* new ThreadControlReplyRejectedError({ threadId: input.threadId, commandId });
      }

      const shell = yield* readShell(input.threadId);
      const pending = yield* pendingReplyTarget(shell);
      if (pending.kind === "approval") {
        return { outcome: "rejected", reason: "approval_pending" } as const;
      }
      if (pending.kind === "needs_client") {
        return { outcome: "rejected", reason: "question_needs_client" } as const;
      }
      if (pending.kind === "question") {
        const answer = matchUserInputAnswer(pending.question, input.text);
        if (answer === null) return { outcome: "rejected", reason: "no_matching_option" } as const;
        yield* threads.dispatch({
          type: "runtime-request.respond",
          commandId,
          threadId: shell.id,
          requestId: pending.requestId,
          answers: { [pending.question.id]: answer },
        });
        return { outcome: "answered" } as const;
      }

      // Queues behind a running turn, or starts one when the thread is idle.
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId: shell.id,
        messageId: threadReplyMessageId(input.replyId),
        text: input.text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "mobile",
      });
      return { outcome: "sent" } as const;
    },
  );

  const stop: ThreadControl["Service"]["stop"] = Effect.fn("ThreadControl.stop")(
    function* (threadId) {
      const shell = yield* readShell(threadId);
      const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      yield* threads.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`thread-stop:${uuid}`),
        threadId: shell.id,
      });
    },
  );

  const listGlances: ThreadControl["Service"]["listGlances"] = Effect.fn(
    "ThreadControl.listGlances",
  )(function* () {
    const [snapshot, projectShells] = yield* Effect.all([
      threads.getShellSnapshot(),
      projects.listShells(),
    ]);
    return buildThreadGlanceList({
      environmentId: yield* environment.getEnvironmentId,
      projects: projectShells,
      threads: snapshot.threads,
      nowMs: (yield* DateTime.now).epochMilliseconds,
    });
  });

  const getGlance: ThreadControl["Service"]["getGlance"] = Effect.fn("ThreadControl.getGlance")(
    function* (threadId) {
      const shell = yield* readShell(threadId);
      const project = yield* projects.getShell(shell.projectId);
      const projectTitle = Option.match(project, { onNone: () => "", onSome: (p) => p.title });
      const environmentId = yield* environment.getEnvironmentId;
      const phase =
        projectThreadAwarenessV2({ environmentId, project: { title: projectTitle }, thread: shell })
          ?.phase ?? null;
      const excerpt = yield* latestAgentExcerpt(shell);
      const target = yield* pendingReplyTarget(shell);
      const pending = target.kind === "question" ? target : null;
      return {
        environmentId,
        threadId: shell.id,
        projectTitle,
        threadTitle: shell.title,
        modelTitle: shell.modelSelection.model,
        phase,
        updatedAt: DateTime.formatIso(shell.updatedAt),
        ...(excerpt === undefined ? {} : { excerpt }),
        ...(pending === null
          ? {}
          : {
              question: {
                text: pending.question.question,
                options: pending.question.options.map((option) => option.label),
                allowsFreeText: pending.question.allowCustomAnswer !== false,
              },
            }),
        // Work is in flight, including work blocked on the user. Stop also ends background work.
        canStop: phase !== null && !isFinished(phase),
      };
    },
  );

  return ThreadControl.of({ reply, stop, listGlances, getGlance });
});

export const layer = Layer.effect(ThreadControl, make);

/**
 * The watch's thread list for one environment: every thread whose agent needs the user or is
 * working, plus finished threads from the last day that haven't been settled.
 */
export function buildThreadGlanceList(input: {
  readonly environmentId: ThreadGlanceRow["environmentId"];
  readonly projects: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly nowMs: number;
}): ThreadGlanceList {
  const projectsById = new Map(input.projects.map((project) => [project.id, project]));
  const rows = input.threads.flatMap((thread): ReadonlyArray<ThreadGlanceRow> => {
    const project = projectsById.get(thread.projectId);
    if (!project || thread.archivedAt !== null) return [];
    const state = projectThreadAwarenessV2({ environmentId: input.environmentId, project, thread });
    if (!state) return [];
    if (
      isFinished(state.phase) &&
      input.nowMs - DateTime.toEpochMillis(thread.updatedAt) > RECENT_WINDOW_MS
    ) {
      return [];
    }
    return [
      {
        environmentId: state.environmentId,
        threadId: state.threadId,
        projectTitle: state.projectTitle,
        threadTitle: state.threadTitle,
        phase: state.phase,
        updatedAt: state.updatedAt,
      },
    ];
  });
  const sorted = rows.toSorted(
    (left, right) =>
      phaseRank(left.phase) - phaseRank(right.phase) ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
  const active = sorted.filter((row) => row.phase !== "completed");
  const finished = sorted.filter((row) => row.phase === "completed").slice(0, MAX_RECENT_ROWS);
  return { threads: [...active, ...finished] };
}

/**
 * Agent messages are Markdown. A watch shows plain text, so this drops code blocks and
 * formatting, collapses whitespace, and keeps the opening, which is usually the summary.
 */
function glanceExcerpt(markdown: string, limit = EXCERPT_LIMIT): string | undefined {
  const plain = markdown
    .replace(/```[\s\S]*?(```|$)/gu, " ")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+\.|>)\s+/gmu, "")
    .replace(/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/gu, "$2")
    .replace(/\s+/gu, " ")
    .trim();
  if (plain === "") return undefined;
  if (plain.length <= limit) return plain;
  const cut = plain.slice(0, limit);
  const wordEnd = cut.lastIndexOf(" ");
  return `${(wordEnd > limit * 0.6 ? cut.slice(0, wordEnd) : cut).trimEnd()}…`;
}

const NUMBER_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

const normalize = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+$/u, "")
    .trim();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Maps a spoken or typed reply onto a question's options, the way the composer would submit
 * it: an option's value (or label), or the text itself when the question takes free answers.
 * Returns null when the question only accepts its options and the reply matched none.
 */
export function matchUserInputAnswer(
  question: Pick<OrchestrationV2UserInputQuestion, "options" | "multiSelect" | "allowCustomAnswer">,
  text: string,
): string | ReadonlyArray<string> | null {
  const reply = normalize(text);
  const pick = (index: number) => {
    const option = question.options[index]!;
    const value = option.value ?? option.label;
    return question.multiSelect ? [value] : value;
  };

  const exact = question.options.findIndex(
    (option) =>
      normalize(option.label) === reply ||
      (option.value !== undefined && normalize(option.value) === reply),
  );
  if (exact >= 0) return pick(exact);

  // "2", "two", "option 2": dictation produces both digits and words.
  const position = reply.match(/^(?:option\s+|number\s+)?(\w+)$/u)?.[1];
  if (position !== undefined) {
    const index = /^\d+$/u.test(position) ? Number(position) - 1 : NUMBER_WORDS.indexOf(position);
    if (index >= 0 && index < question.options.length) return pick(index);
  }

  // "Vitest please": exactly one option named inside a longer reply.
  const mentioned = question.options.flatMap((option, index) =>
    new RegExp(`(^|\\W)${escapeRegExp(normalize(option.label))}(\\W|$)`, "u").test(reply)
      ? [index]
      : [],
  );
  if (mentioned.length === 1) return pick(mentioned[0]!);

  return question.allowCustomAnswer === false ? null : text.trim();
}
