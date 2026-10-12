import { useCallback, useMemo } from "react";

import type { JjAction, JjRunActionResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { useAtomCommand } from "./use-atom-command";
import { setPendingConnectionError } from "./use-remote-environment-registry";
import { useSelectedThreadWorktree } from "./use-selected-thread-worktree";
import { useThreadSelection } from "./use-thread-selection";
import { showGitActionResult } from "./use-vcs-action-state";
import { vcsActionManager, vcsEnvironment } from "./vcs";

/** Runs jj actions in the selected thread's working copy. The server refreshes status afterwards. */
export function useSelectedThreadJjActions() {
  const jjRunAction = useAtomCommand(vcsEnvironment.jjRunAction, { reportFailure: false });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();

  const runJjAction = useCallback(
    async (action: JjAction, label: string): Promise<JjRunActionResult | null> => {
      if (!selectedThread || !selectedThreadCwd) {
        return null;
      }
      const environmentId = selectedThread.environmentId;
      const cwd = selectedThreadCwd;
      setPendingConnectionError(null);
      const result = await vcsActionManager.track(
        appAtomRegistry,
        { environmentId, cwd },
        { operation: "run_change_request", label },
        () =>
          jjRunAction({
            environmentId,
            input: { cwd, action, threadId: selectedThread.id },
          }),
      );
      if (AsyncResult.isFailure(result)) {
        const error = Cause.squash(result.cause);
        const message = error instanceof Error ? error.message : "jj action failed.";
        setPendingConnectionError(message);
        showGitActionResult({ type: "error", title: "jj action failed", description: message });
        return null;
      }
      const conflicts = result.value.conflictedChanges.length;
      showGitActionResult({
        type: "success",
        title: result.value.summary,
        ...(conflicts > 0
          ? { description: `${conflicts} change${conflicts === 1 ? " has" : "s have"} conflicts` }
          : {}),
        ...(result.value.pullRequestUrl ? { prUrl: result.value.pullRequestUrl } : {}),
      });
      return result.value;
    },
    [jjRunAction, selectedThread, selectedThreadCwd],
  );

  const refresh = useCallback(async () => {
    if (!selectedThread || !selectedThreadCwd) {
      return;
    }
    await refreshStatus({
      environmentId: selectedThread.environmentId,
      input: { cwd: selectedThreadCwd },
    });
  }, [refreshStatus, selectedThread, selectedThreadCwd]);

  return useMemo(
    () => ({
      /** An empty message lets the server's commit writer describe the change. */
      commit: (message: string) =>
        runJjAction(
          { _tag: "commit", ...(message.length > 0 ? { message } : {}) },
          "Committing change",
        ),
      push: (changeId: string) => runJjAction({ _tag: "push", changeId }, "Pushing change"),
      createPr: (changeId: string) =>
        runJjAction({ _tag: "pr", changeId }, "Creating pull request"),
      refresh,
    }),
    [refresh, runJjAction],
  );
}
