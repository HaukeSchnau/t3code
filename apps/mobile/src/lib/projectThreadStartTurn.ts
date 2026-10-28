import {
  CommandId,
  MessageId,
  ThreadId,
  type ChatAttachment,
  type ModelSelection,
  type OrchestrationMessageContext,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type WorkspaceProfile,
  type SkillPackId,
} from "@t3tools/contracts";
import {
  deriveThreadTitleSeed,
  threadTitleTextFromPrompt,
} from "@t3tools/client-runtime/operations";

import type { UploadedMobileAttachment } from "./attachmentUpload";

export interface ProjectThreadStartTurnSpec {
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly text: string;
  readonly titleText?: string;
  readonly context?: OrchestrationMessageContext;
  readonly uploadedAttachments: ReadonlyArray<UploadedMobileAttachment | ChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin: boolean;
  readonly worktreeBranchName: string;
  /** Fork: a new server-managed workspace instead of a Git worktree (patches/workspaces.md). */
  readonly managedWorkspace?:
    | { readonly isolated?: boolean; readonly profile?: WorkspaceProfile }
    | undefined;
  /** Fork: the task's skill packs; absent follows the project default. */
  readonly skillPackIds?: ReadonlyArray<SkillPackId>;
}

export function buildProjectThreadStartTurnInput(spec: ProjectThreadStartTurnSpec) {
  const title = deriveThreadTitleSeed({
    text: spec.titleText ?? spec.text,
    attachments: spec.uploadedAttachments,
  });
  const managedWorkspace =
    spec.workspaceMode === "worktree" && spec.managedWorkspace !== undefined
      ? {
          ...(spec.branch === null ? {} : { baseRef: spec.branch }),
          ...(spec.startFromOrigin ? { startFromOrigin: true } : {}),
          ...spec.managedWorkspace,
        }
      : undefined;
  const isWorktree = spec.workspaceMode === "worktree" && managedWorkspace === undefined;
  return {
    commandId: CommandId.make(spec.commandId),
    creationSource: "mobile" as const,
    threadId: ThreadId.make(spec.threadId),
    message: {
      messageId: MessageId.make(spec.messageId),
      role: "user" as const,
      text: spec.text,
      ...(spec.context ? { context: spec.context } : {}),
      attachments: spec.uploadedAttachments,
    },
    modelSelection: spec.modelSelection,
    titleSeed: title,
    runtimeMode: spec.runtimeMode,
    interactionMode: spec.interactionMode,
    bootstrap: {
      createThread: {
        projectId: spec.projectId,
        title,
        modelSelection: spec.modelSelection,
        runtimeMode: spec.runtimeMode,
        interactionMode: spec.interactionMode,
        branch: spec.branch,
        worktreePath: isWorktree ? null : spec.worktreePath,
        createdAt: spec.createdAt,
        ...(spec.skillPackIds ? { skillPackIds: spec.skillPackIds } : {}),
      },
      ...(isWorktree
        ? {
            prepareWorktree: {
              projectCwd: spec.projectCwd,
              baseBranch: spec.branch!,
              branch: spec.worktreeBranchName,
              ...(spec.startFromOrigin ? { startFromOrigin: true } : {}),
            },
            runSetupScript: true,
          }
        : {}),
      ...(managedWorkspace === undefined
        ? {}
        : { prepareWorkspace: managedWorkspace, runSetupScript: true }),
    },
    createdAt: spec.createdAt,
  };
}

export function deriveThreadTitleFromPrompt(value: string): string {
  const title = threadTitleTextFromPrompt(value) || "New thread";
  return title.length <= 72 ? title : `${title.slice(0, 69).trimEnd()}...`;
}
