import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo, useMemo } from "react";
import { GitForkIcon } from "lucide-react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { useGitStatus } from "../lib/gitStatusState";
import { useStore } from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import {
  type EnvMode,
  type EnvironmentOption,
  resolveEffectiveEnvMode,
} from "./BranchToolbar.logic";
import { BranchToolbarBranchSelector } from "./BranchToolbarBranchSelector";
import { BranchToolbarEnvironmentSelector } from "./BranchToolbarEnvironmentSelector";
import { BranchToolbarEnvModeSelector } from "./BranchToolbarEnvModeSelector";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface BranchToolbarProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  onEnvModeChange: (mode: EnvMode) => void;
  effectiveEnvModeOverride?: EnvMode;
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  envLocked: boolean;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  onCommitGraphOpen?: () => void;
  canOpenCommitGraph?: boolean;
  availableEnvironments?: readonly EnvironmentOption[];
  onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}

export const BranchToolbar = memo(function BranchToolbar({
  environmentId,
  threadId,
  draftId,
  onEnvModeChange,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  envLocked,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  onCommitGraphOpen,
  canOpenCommitGraph = true,
  availableEnvironments,
  onEnvironmentChange,
}: BranchToolbarProps) {
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const serverThreadSelector = useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]);
  const serverThread = useStore(serverThreadSelector);
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProjectSelector = useMemo(
    () => createProjectSelectorByRef(activeProjectRef),
    [activeProjectRef],
  );
  const activeProject = useStore(activeProjectSelector);
  const hasActiveThread = serverThread !== undefined || draftThread !== null;
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeCwd = activeWorktreePath ?? activeProject?.cwd ?? null;
  const gitStatus = useGitStatus({ environmentId, cwd: activeCwd });
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread: serverThread !== undefined,
      draftThreadEnvMode: draftThread?.envMode,
    });
  const envModeLocked = envLocked || (serverThread !== undefined && activeWorktreePath !== null);

  const showEnvironmentPicker =
    availableEnvironments && availableEnvironments.length > 1 && onEnvironmentChange;

  if (!hasActiveThread || !activeProject) return null;

  return (
    <div className="mx-auto flex w-full max-w-208 items-center justify-between px-2.5 pb-3 pt-1 sm:px-3">
      <div className="flex items-center gap-1">
        {showEnvironmentPicker && (
          <>
            <BranchToolbarEnvironmentSelector
              envLocked={envLocked}
              environmentId={environmentId}
              availableEnvironments={availableEnvironments}
              onEnvironmentChange={onEnvironmentChange}
            />
            <Separator orientation="vertical" className="mx-0.5 h-3.5!" />
          </>
        )}
        <BranchToolbarEnvModeSelector
          envLocked={envModeLocked}
          effectiveEnvMode={effectiveEnvMode}
          activeWorktreePath={activeWorktreePath}
          onEnvModeChange={onEnvModeChange}
        />
      </div>

      <BranchToolbarBranchSelector
        environmentId={environmentId}
        threadId={threadId}
        {...(draftId ? { draftId } : {})}
        envLocked={envLocked}
        {...(effectiveEnvModeOverride ? { effectiveEnvModeOverride } : {})}
        {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
        {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
      />
      {gitStatus.data?.vcs === "jj" && onCommitGraphOpen && canOpenCommitGraph ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Open JJ graph"
                size="icon-xs"
                variant="outline"
                onClick={onCommitGraphOpen}
              >
                <GitForkIcon />
              </Button>
            }
          />
          <TooltipPopup side="top">Open JJ graph</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
});
