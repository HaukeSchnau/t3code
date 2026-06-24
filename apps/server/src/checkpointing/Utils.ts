import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, ThreadWorkspaceId, type ThreadId } from "@t3tools/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly workspaceId?: ThreadWorkspaceId | null | undefined;
    readonly worktreePath: string | null;
  };
  readonly workspaceRoots?: ReadonlyArray<{
    readonly workspaceId: ThreadWorkspaceId;
    readonly checkoutPath: string;
  }>;
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  if (input.thread.workspaceId) {
    const workspaceRoot = input.workspaceRoots?.find(
      (root) => root.workspaceId === input.thread.workspaceId,
    );
    if (workspaceRoot) {
      return workspaceRoot.checkoutPath;
    }
  }

  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
