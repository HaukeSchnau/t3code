import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { cleanupFailedUploadedAttachments, prepareDispatchCommand } from "./Normalizer.ts";
import { CommandPreprocessingCoordinator } from "./Services/CommandPreprocessingCoordinator.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import { openRequests } from "./decider.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotMaterializer } from "./Services/ProjectionSnapshotMaterializer.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { buildThreadGlance, buildThreadGlanceList } from "./threadGlance.ts";
import { planThreadReply, threadReplyCommandId, threadReplyMessageId } from "./threadReply.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotMaterializer = yield* ProjectionSnapshotMaterializer;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const commandPreprocessing = yield* CommandPreprocessingCoordinator;
    const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
    const commandReceipts = yield* OrchestrationCommandReceiptRepository;
    const environmentIdentity = yield* ServerEnvironment.ServerEnvironmentIdentity;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotMaterializer
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.activityDetailMode ?? "full",
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return args.payload.reasoningMessages === "true"
            ? snapshot.value
            : {
                ...snapshot.value,
                thread: {
                  ...snapshot.value.thread,
                  messages: snapshot.value.thread.messages.map((message) =>
                    message.role === "reasoning"
                      ? { ...message, role: "system" as const }
                      : message,
                  ),
                },
              };
        }),
      )
      .handle(
        "turnActivities",
        Effect.fn("environment.orchestration.turnActivities")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getTurnActivitiesSnapshot(args.params.threadId, args.params.turnId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return snapshot.value;
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
            const receivedAt = yield* commandPreprocessing
              .getReceivedAt(args.payload.commandId)
              .pipe(
                Effect.catch((cause) =>
                  failEnvironmentInternal("orchestration_dispatch_failed", cause),
                ),
              );
            yield* ProjectCloneTracker.rejectCommandsDuringClone(
              projectCloneTracker,
              args.payload,
            ).pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
            const preparedCommand = yield* prepareDispatchCommand(args.payload, receivedAt).pipe(
              Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
            );
            const normalizedCommand = preparedCommand.command;
            if (normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap) {
              return yield* failEnvironmentInvalidRequest("invalid_command");
            }
            return yield* orchestrationEngine.resolveReceipt(normalizedCommand).pipe(
              Effect.flatMap(
                Option.match({
                  onSome: Effect.succeed,
                  onNone: () =>
                    Effect.gen(function* () {
                      const progress = yield* commandPreprocessing.claim(normalizedCommand);
                      if (!progress.deferredPreprocessingCompleted) {
                        yield* preparedCommand.performDeferredPreprocessing;
                        yield* commandPreprocessing.markCompleted(
                          normalizedCommand,
                          "deferred-preprocessing-completed",
                        );
                      }
                      return yield* orchestrationEngine.dispatch(normalizedCommand);
                    }),
                }),
              ),
              Effect.tap(() =>
                ProjectCloneTracker.discardCloneForDeletedProject(
                  projectCloneTracker,
                  normalizedCommand,
                ),
              ),
              Effect.tapError(() =>
                cleanupFailedUploadedAttachments(args.payload, normalizedCommand),
              ),
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
          },
          (effect, args) =>
            commandPreprocessing.withCommandLock(
              args.payload.commandId,
              effect,
              "threadId" in args.payload ? args.payload.threadId : undefined,
            ),
        ),
      )
      .handle(
        // Fork: free-text replies from notification actions. See patches/notification-replies.md.
        "reply",
        Effect.fn("environment.orchestration.reply")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const threadId = args.params.threadId;
          const commandId = threadReplyCommandId(args.payload.replyId);
          const failDispatch = (cause: unknown) =>
            failEnvironmentInternal("orchestration_dispatch_failed", cause);

          // A retry after a lost response finds the first attempt's receipt. Checking it before
          // planning matters: the answered question is gone by now, so the plan would differ.
          const receipt = yield* commandReceipts
            .getByCommandId({ commandId })
            .pipe(Effect.catch(failDispatch));
          if (Option.isSome(receipt)) {
            return receipt.value.status === "accepted"
              ? ({ outcome: "already_delivered" } as const)
              : yield* failDispatch(receipt.value.error ?? "Previously rejected.");
          }

          const shell = yield* projectionSnapshotQuery
            .getThreadShellById(threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(shell)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          const detail = shell.value.hasPendingUserInput
            ? yield* projectionSnapshotQuery
                .getThreadDetailSnapshot(threadId, "full")
                .pipe(
                  Effect.catch((cause) =>
                    failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
                  ),
                )
            : Option.none();
          const plan = planThreadReply({
            text: args.payload.text,
            hasPendingApprovals: shell.value.hasPendingApprovals,
            hasPendingUserInput: shell.value.hasPendingUserInput,
            openRequests: Option.match(detail, {
              onNone: () => [],
              onSome: (snapshot) => [...openRequests(snapshot.thread).values()],
            }),
          });
          if (plan._tag === "Rejected") {
            return { outcome: "rejected", reason: plan.reason } as const;
          }

          const createdAt = DateTime.formatIso(yield* DateTime.now);
          if (plan._tag === "Answer") {
            yield* orchestrationEngine
              .dispatch({
                type: "thread.user-input.respond",
                commandId,
                threadId,
                requestId: plan.requestId,
                answers: plan.answers,
                createdAt,
              })
              .pipe(Effect.catch(failDispatch));
            return { outcome: "answered" } as const;
          }
          // Queue-while-busy, like the composer: starts a turn when the thread is idle.
          yield* orchestrationEngine
            .dispatch({
              type: "thread.message.queue",
              commandId,
              threadId,
              message: {
                messageId: threadReplyMessageId(args.payload.replyId),
                role: "user",
                text: args.payload.text,
                attachments: [],
              },
              runtimeMode: shell.value.runtimeMode,
              interactionMode: shell.value.interactionMode,
              createdAt,
            })
            .pipe(Effect.catch(failDispatch));
          return { outcome: "sent" } as const;
        }),
      )
      .handle(
        // Fork: compact thread state for the Apple Watch. See patches/apple-watch.md.
        "glance",
        Effect.fn("environment.orchestration.glance")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotMaterializer
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
          return buildThreadGlanceList({
            environmentId: yield* environmentIdentity.getEnvironmentId,
            snapshot,
            nowMs: (yield* DateTime.now).epochMilliseconds,
          });
        }),
      )
      .handle(
        "threadGlance",
        Effect.fn("environment.orchestration.threadGlance")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const failSnapshot = (cause: unknown) =>
            failEnvironmentInternal("orchestration_thread_snapshot_failed", cause);
          const shell = yield* projectionSnapshotQuery
            .getThreadShellById(args.params.threadId)
            .pipe(Effect.catch(failSnapshot));
          if (Option.isNone(shell)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          const project = yield* projectionSnapshotQuery
            .getProjectShellById(shell.value.projectId)
            .pipe(Effect.catch(failSnapshot));
          // The latest turn holds the newest agent message. A pending question needs the full
          // activity list, the same read the reply endpoint uses.
          const detail = yield* (
            shell.value.hasPendingUserInput
              ? projectionSnapshotQuery.getThreadDetailSnapshot(args.params.threadId, "full")
              : projectionSnapshotQuery.getThreadDetailSnapshot(args.params.threadId, "compact", {
                  turnLimit: 1,
                })
          ).pipe(Effect.catch(failSnapshot));
          return buildThreadGlance({
            environmentId: yield* environmentIdentity.getEnvironmentId,
            project: Option.getOrElse(project, () => ({ title: "" })),
            thread: shell.value,
            messages: Option.match(detail, {
              onNone: () => [],
              onSome: (snapshot) => snapshot.thread.messages,
            }),
            openRequests: Option.match(detail, {
              onNone: () => [],
              onSome: (snapshot) => [...openRequests(snapshot.thread).values()],
            }),
          });
        }),
      );
  }),
);
