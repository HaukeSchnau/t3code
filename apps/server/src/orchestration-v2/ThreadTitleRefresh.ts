import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  type OrchestrationV2ConversationMessage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { formatThreadTitleContext } from "../textGeneration/ThreadTitleContext.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { randomUuidV4 } from "./RandomUuid.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

// A burst of follow-ups or steering messages settles into one generation.
const REFRESH_DEBOUNCE = "5 seconds";
const REFRESH_CONCURRENCY = 3;

class ThreadTitleRefresh extends Context.Service<
  ThreadTitleRefresh,
  {
    /**
     * Refreshes the thread's automatic title once its user turns go quiet. A
     * newer request for the same thread replaces a pending or running one.
     */
    readonly schedule: (threadId: ThreadId) => Effect.Effect<void>;
    /** Waits until no refresh is pending or running. */
    readonly drain: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/orchestration-v2/ThreadTitleRefresh") {}

/** A message the user wrote, not a notification, delegated result, scheduled prompt, or provider echo. */
function isUserTurn(
  message: Pick<
    OrchestrationV2ConversationMessage,
    | "role"
    | "createdBy"
    | "creationSource"
    | "notification"
    | "delegatedCompletion"
    | "scheduledTaskId"
  >,
): boolean {
  return (
    message.role === "user" &&
    message.createdBy === "user" &&
    message.creationSource !== "provider" &&
    message.notification === undefined &&
    message.delegatedCompletion === undefined &&
    message.scheduledTaskId === undefined
  );
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const pending = yield* FiberMap.make<ThreadId, void, never>();
  const permits = yield* Semaphore.make(REFRESH_CONCURRENCY);

  const refresh = Effect.fn("ThreadTitleRefresh.refresh")(function* (threadId: ThreadId) {
    const settings = yield* serverSettings.getSettings;
    if (!settings.refreshGeneratedThreadTitles) return;
    const { thread } = yield* threads.getThreadRecords(threadId, []);
    if (
      thread.titleMode !== "automatic" ||
      thread.titleRegeneration != null ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null
    ) {
      return;
    }
    const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageRoles: ["user", "assistant"],
    });
    const settled = messages.filter((message) => !message.streaming);
    // First-message generation titles the first turn.
    if (settled.filter(isUserTurn).length < 2) return;
    const project = yield* projects.get(thread.projectId);
    if (Option.isNone(project)) return;

    const context = formatThreadTitleContext(settled);
    const generated = yield* textGeneration.generateThreadTitle({
      cwd: thread.worktreePath ?? project.value.workspaceRoot,
      message: context.message,
      attachments: context.attachments,
      previousTitle: thread.title,
      automaticRefresh: true,
      modelSelection: resolveProjectSettings(settings, thread.projectId).settings
        .textGenerationModelSelection,
    });
    const title = generated.title.trim();
    if (title === "New thread" || title === thread.title.trim()) return;

    const requestId = CommandId.make(`thread-title-refresh:${threadId}:${yield* randomUuidV4}`);
    yield* threads.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: requestId,
      threadId,
      requestId,
      title,
      expectedTitle: thread.title,
    });
  });

  const schedule: ThreadTitleRefresh["Service"]["schedule"] = (threadId) =>
    FiberMap.run(
      pending,
      threadId,
      Effect.sleep(REFRESH_DEBOUNCE).pipe(
        Effect.andThen(permits.withPermit(refresh(threadId))),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Thread title refresh failed", { threadId, cause }),
        ),
      ),
    ).pipe(Effect.asVoid);

  const start: ThreadTitleRefresh["Service"]["start"] = Effect.fn("ThreadTitleRefresh.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) =>
          event.type === "message.updated" && isUserTurn(event.payload)
            ? schedule(event.threadId)
            : Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("Thread title refresh event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  return ThreadTitleRefresh.of({ schedule, drain: FiberMap.awaitEmpty(pending), start });
});
