/**
 * `t3_worktree_handoff` for projects whose new workspaces are not Git
 * worktrees: jj repositories, plain directories, and hosts with isolated
 * runtimes. Mirrors the Git handoff in WorktreeMcpService: create, bind with
 * a recheck, queue the continuation, then run setup. See patches/workspaces.md.
 *
 * @module ManagedWorkspaceHandoff
 */
import {
  type CommandId,
  type MessageId,
  type ProjectId,
  type ProjectScript,
  WorktreeMcpFailure,
  type WorktreeMcpContinuationStatus,
  type WorktreeMcpHandoffInput,
  type WorktreeMcpHandoffResult,
  type WorktreeMcpSetupScriptStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import type * as ManagedWorkspaces from "../workspace/ManagedWorkspaces.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const failure = (code: WorktreeMcpFailure["code"], message: string) =>
  new WorktreeMcpFailure({ code, message });

const detail = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

export const managedWorkspaceHandoff = Effect.fn("ManagedWorkspaceHandoff.handoff")(function* (
  input: {
    readonly scope: McpInvocationScope;
    readonly handoff: WorktreeMcpHandoffInput;
    readonly project: {
      readonly id: ProjectId;
      readonly workspaceRoot: string;
      readonly scripts: ReadonlyArray<ProjectScript>;
    };
    readonly startFromOrigin: boolean;
    readonly ids: {
      readonly commandId: CommandId;
      readonly continuationCommandId: CommandId;
      readonly continuationMessageId: MessageId;
    };
  },
  services: {
    readonly workspaces: ManagedWorkspaces.ManagedWorkspaces["Service"];
    readonly threads: ThreadManagementService.ThreadManagementService["Service"];
    readonly setupScripts: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
  },
) {
  const { scope, handoff, project } = input;
  if (handoff.path !== undefined) {
    return yield* failure(
      "invalid_request",
      "This project's workspaces are created in the server-managed workspace directory; omit path.",
    );
  }
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const created = yield* restore(
        services.workspaces.create({
          projectId: project.id,
          projectRoot: project.workspaceRoot,
          threadId: scope.threadId,
          // The requested branch name is the workspace's name.
          title: handoff.branch,
          baseRef: handoff.baseRef,
          startFromOrigin: input.startFromOrigin,
        }),
      ).pipe(
        Effect.mapError((error) =>
          failure("operation_failed", `Unable to create the workspace: ${error.message}`),
        ),
      );
      const worktreePath = created.worktreePath;

      // Like the Git handoff: anything that fails before the binding commits
      // removes the new workspace; an interrupt may have committed, so it keeps it.
      yield* Effect.gen(function* () {
        const recheck = yield* services.threads
          .getThreadRecords(scope.threadId, [])
          .pipe(Effect.mapError(() => failure("thread_not_found", "The thread was not found.")));
        if (recheck.thread.worktreePath !== null) {
          return yield* failure(
            "already_in_worktree",
            `Thread '${scope.threadId}' is already attached to '${recheck.thread.worktreePath}'.`,
          );
        }
        if (recheck.thread.archivedAt !== null) {
          return yield* failure(
            "invalid_request",
            `Thread '${scope.threadId}' was archived while the workspace was being created.`,
          );
        }
        yield* services.threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: input.ids.commandId,
            threadId: scope.threadId,
            branch: null,
            worktreePath,
            expectedWorktreePath: null,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause as Cause.Cause<never>)
                : Effect.fail(
                    failure(
                      "operation_failed",
                      `Unable to re-point the thread at the workspace: ${detail(cause)}`,
                    ),
                  ),
            ),
          );
      }).pipe(
        Effect.onError((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : services.workspaces.discard(worktreePath).pipe(Effect.ignore),
        ),
      );

      const continuation: WorktreeMcpContinuationStatus =
        handoff.continuationPrompt === undefined
          ? { status: "skipped" }
          : yield* services.threads
              .sendToThread({
                projectId: project.id,
                commandId: input.ids.continuationCommandId,
                threadId: scope.threadId,
                messageId: input.ids.continuationMessageId,
                text: handoff.continuationPrompt,
                attachments: [],
                mode: "queue",
                createdBy: "agent",
                creationSource: "mcp",
              })
              .pipe(
                Effect.map((sent): WorktreeMcpContinuationStatus => ({
                  status: "scheduled",
                  delivery: sent.delivery,
                })),
                Effect.catchCause((cause) =>
                  Effect.succeed<WorktreeMcpContinuationStatus>({
                    status: "failed",
                    detail: detail(cause),
                  }),
                ),
              );

      const setupScript: WorktreeMcpSetupScriptStatus =
        handoff.runSetupScript === false
          ? { status: "skipped" }
          : yield* services.setupScripts
              .runForThread({
                threadId: scope.threadId,
                projectId: project.id,
                projectCwd: project.workspaceRoot,
                worktreePath,
                project,
              })
              .pipe(
                Effect.map((result): WorktreeMcpSetupScriptStatus =>
                  result.status === "started"
                    ? {
                        status: "started",
                        scriptName: result.scriptName,
                        terminalId: result.terminalId,
                      }
                    : { status: "no-script" },
                ),
                Effect.catchCause((cause) =>
                  Effect.succeed<WorktreeMcpSetupScriptStatus>({
                    status: "failed",
                    detail: detail(cause),
                  }),
                ),
              );

      return {
        worktreePath,
        branch: handoff.branch,
        baseRef: handoff.baseRef ?? "@",
        startedFromOrigin: input.startFromOrigin,
        setupScript,
        continuation,
        note: `Handoff recorded into a new ${created.backend === "jj" ? "jj workspace" : created.backend === "isolated" ? "isolated workspace" : "workspace copy"} named after the requested branch; no Git branch was created. Changing the workspace detaches this provider session, so the current turn ends shortly after this call.${continuation.status === "scheduled" ? " The queued continuation prompt starts the next turn inside the workspace." : " Pass continuationPrompt to resume automatically."} The workspace is kept when the thread is deleted.`,
      } satisfies WorktreeMcpHandoffResult;
    }),
  );
});
