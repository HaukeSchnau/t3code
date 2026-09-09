import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { CheckIcon, FolderGit2Icon, FolderIcon } from "lucide-react";
import { memo, useId, useMemo, useState } from "react";
import type { EnvironmentId, ProjectId, WorkspaceProfile } from "@t3tools/contracts";
import {
  filterWorkspaceGroups,
  withArchivedWorkspaces,
  workspaceLabel,
  type ThreadWorkspaceGroup,
} from "@t3tools/client-runtime/state/workspaces";

import type { EnvMode } from "./BranchToolbar.logic";
import { composerFloatingLayerProps } from "./chat/composerEventScope";
import { Button } from "./ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";

interface BranchToolbarEnvModeSelectorProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  envLocked: boolean;
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  onEnvModeChange: (mode: EnvMode) => void;
  workspaces: ReadonlyArray<ThreadWorkspaceGroup<unknown>>;
  onSelectWorkspace: (workspace: ThreadWorkspaceGroup<unknown>) => void;
  isolatedWorkspaces: boolean;
  profile: WorkspaceProfile;
  onProfileChange: (profile: WorkspaceProfile) => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  environmentId,
  projectId,
  envLocked,
  effectiveEnvMode,
  activeWorktreePath,
  onEnvModeChange,
  workspaces,
  onSelectWorkspace,
  isolatedWorkspaces,
  profile,
  onProfileChange,
}: BranchToolbarEnvModeSelectorProps) {
  const profileGroupId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showSettled, setShowSettled] = useState(false);
  const archiveEnvironmentIds = useMemo(
    () => (open && (showSettled || query.trim()) ? [environmentId] : []),
    [open, showSettled, query, environmentId],
  );
  const archive = useArchivedThreadSnapshots(archiveEnvironmentIds);
  const visible = useMemo(
    () =>
      filterWorkspaceGroups(withArchivedWorkspaces(workspaces, archive.snapshots, projectId), {
        query,
        showSettled,
      }),
    [workspaces, archive.snapshots, projectId, query, showSettled],
  );
  const isNew = effectiveEnvMode === "worktree" && !activeWorktreePath;
  const label = activeWorktreePath
    ? workspaceLabel(activeWorktreePath)
    : isNew
      ? "New workspace"
      : "Project checkout";
  const content = (
    <>
      <FolderGit2Icon className="size-3 shrink-0" />
      <span
        data-composer-label
        className="min-w-0 max-w-[180px] truncate group-data-[compact]/composer-context:max-w-0"
      >
        <span
          data-composer-label-motion
          className="block min-w-0 max-w-[180px] truncate group-data-[compact]/composer-context:opacity-0"
        >
          {label}
        </span>
      </span>
    </>
  );
  if (envLocked)
    return (
      <span
        aria-label={label}
        className="inline-flex h-7 min-w-0 items-center gap-1 px-2 text-xs text-muted-foreground/70 sm:h-6"
        data-composer-context-control
      >
        {content}
      </span>
    );

  const selectMode = (mode: EnvMode) => {
    onEnvModeChange(mode);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant="ghost" size="xs" />}
        aria-label="Workspace"
        className="min-w-0 shrink font-normal text-xs!"
        data-composer-context-control
      >
        {content}
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        side="top"
        className="w-80 max-w-[calc(100vw-2rem)]"
        viewportClassName="p-2"
        {...composerFloatingLayerProps}
      >
        <div className="px-2 pb-2 text-xs font-medium">Workspace</div>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-accent focus-visible:bg-accent"
          onClick={() => selectMode("worktree")}
        >
          <FolderGit2Icon className="size-4 shrink-0" />
          <span className="flex-1">
            New workspace
            <span className="block text-xs text-muted-foreground">
              {isolatedWorkspaces
                ? "Separate files, tools and services"
                : "A separate checkout for this task"}
            </span>
          </span>
          {isNew && <CheckIcon className="size-3" />}
        </button>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-accent focus-visible:bg-accent"
          onClick={() => selectMode("local")}
        >
          <FolderIcon className="size-4 shrink-0" />
          <span className="flex-1">Project checkout</span>
          {!isNew && !activeWorktreePath && <CheckIcon className="size-3" />}
        </button>
        {
          <>
            <input
              aria-label="Find workspace"
              placeholder="Find workspace…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="my-2 w-full rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            {archive.isLoading && (
              <p className="p-2 text-xs text-muted-foreground">Loading settled workspaces…</p>
            )}
            {archive.error && <p className="p-2 text-xs text-destructive">{archive.error}</p>}
            <div className="max-h-60 overflow-y-auto">
              {visible.map((workspace) => (
                <button
                  type="button"
                  key={workspace.key}
                  className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm hover:bg-accent focus-visible:bg-accent"
                  onClick={() => {
                    onSelectWorkspace(workspace);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{workspace.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {workspace.threads.length}{" "}
                      {workspace.threads.length === 1 ? "thread" : "threads"}
                      {workspace.runningCount > 0
                        ? ` · ${workspace.runningCount} running`
                        : workspace.settled
                          ? " · Settled"
                          : ""}
                    </span>
                  </span>
                  {activeWorktreePath === workspace.checkoutPath && (
                    <CheckIcon className="size-3 shrink-0" />
                  )}
                </button>
              ))}
              {visible.length === 0 && (
                <p className="p-2 text-xs text-muted-foreground">No matching workspaces.</p>
              )}
            </div>
            <label className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={showSettled}
                onChange={(event) => setShowSettled(event.target.checked)}
              />
              Show settled
            </label>
          </>
        }
        {isolatedWorkspaces && isNew && (
          <details className="border-t px-2 pt-2 text-xs">
            <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
            <fieldset className="space-y-2 py-2">
              <legend className="pt-2">Agent setup</legend>
              {(["familiar", "minimal"] as const).map((value) => (
                <label key={value} className="flex items-start gap-2">
                  <input
                    type="radio"
                    name={profileGroupId}
                    className="mt-0.5"
                    checked={profile === value}
                    onChange={() => onProfileChange(value)}
                  />
                  <span>
                    {value === "familiar" ? "Familiar" : "Minimal"}
                    <span className="block text-muted-foreground">
                      {value === "familiar"
                        ? "Keep your global instructions and skills"
                        : "Use the project’s instructions and tools"}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          </details>
        )}
      </PopoverPopup>
    </Popover>
  );
});
