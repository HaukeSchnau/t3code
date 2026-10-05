import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { projectWorkspaceGroups, workspaceLabel } from "@t3tools/client-runtime/state/workspaces";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
} from "lucide-react";
import { memo, type ReactNode, useMemo, useState } from "react";

import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { useWorkspaceProfile } from "../lib/managedWorkspaces";
import { useThreadShellsForProjectRefs } from "../state/entities";
import type { EnvMode } from "./BranchToolbar.logic";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { ComposerControl } from "./chat/ComposerControl";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Radio, RadioGroup } from "./ui/radio-group";

const EMPTY_ENVIRONMENT_IDS: ReadonlyArray<EnvironmentId> = [];

interface ManagedWorkspaceSelectorProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly isolated: boolean;
  readonly forceNewWorktree: boolean;
  readonly envLocked: boolean;
  readonly effectiveEnvMode: EnvMode;
  readonly activeWorktreePath: string | null;
  readonly onEnvModeChange: (mode: EnvMode) => void;
  /** Present for drafts, which can join an existing workspace or return to the checkout. */
  readonly onSelectWorkspace?:
    | ((workspace: { readonly path: string; readonly branch: string | null } | null) => void)
    | undefined;
}

function Row(props: {
  readonly icon?: ReactNode;
  readonly title: string;
  readonly detail?: string | undefined;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent"
      onClick={props.onSelect}
    >
      {props.icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{props.title}</span>
        {props.detail ? (
          <span className="block truncate text-muted-foreground text-xs">{props.detail}</span>
        ) : null}
      </span>
      {props.selected ? <CheckIcon className="size-3.5 shrink-0" /> : null}
    </button>
  );
}

/**
 * Fork: the composer's workspace picker on servers with managed workspaces
 * (patches/workspaces.md). Settled workspaces stay findable through search and
 * Show settled, which load archived threads on demand.
 */
export const ManagedWorkspaceSelector = memo(function ManagedWorkspaceSelector(
  props: ManagedWorkspaceSelectorProps,
) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showSettled, setShowSettled] = useState(false);
  const [profile, setProfile] = useWorkspaceProfile();
  const projectRefs = useMemo(
    () => (open ? [scopeProjectRef(props.environmentId, props.projectId)] : []),
    [open, props.environmentId, props.projectId],
  );
  const threads = useThreadShellsForProjectRefs(projectRefs);
  const archiveEnvironmentIds = useMemo(
    () =>
      open && (showSettled || query.trim().length > 0)
        ? [props.environmentId]
        : EMPTY_ENVIRONMENT_IDS,
    [open, showSettled, query, props.environmentId],
  );
  const archive = useArchivedThreadSnapshots(archiveEnvironmentIds);
  const workspaces = useMemo(
    () =>
      projectWorkspaceGroups({
        projectId: props.projectId,
        threads,
        archived: archive.snapshots,
        query,
        showSettled,
      }),
    [props.projectId, threads, archive.snapshots, query, showSettled],
  );

  const isNew = props.effectiveEnvMode === "worktree" && props.activeWorktreePath === null;
  const label = props.forceNewWorktree
    ? "New workspace per model"
    : props.activeWorktreePath
      ? workspaceLabel(props.activeWorktreePath)
      : isNew
        ? "New workspace"
        : "Project checkout";
  const Icon = props.activeWorktreePath ? FolderGitIcon : isNew ? FolderGit2Icon : FolderIcon;
  const content = (
    <>
      <Icon className="size-3 shrink-0" />
      <ComposerContextLabel>{label}</ComposerContextLabel>
    </>
  );

  if (props.envLocked || props.forceNewWorktree) {
    return (
      <span
        className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
        data-composer-context-control
      >
        {content}
      </span>
    );
  }

  const choose = (action: () => void) => {
    action();
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<ComposerControl size="xs" />}
        aria-label="Workspace"
        className="min-w-0 shrink"
        data-composer-shortcut="composer.workspace"
        data-composer-context-control
      >
        {content}
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" data-composer-control-chevron />
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        side="top"
        width="md"
        padding="compact"
        {...composerFloatingLayerProps}
      >
        <div className="px-2 pb-1 font-medium text-xs">Workspace</div>
        <Row
          icon={<FolderGit2Icon className="size-4 shrink-0" />}
          title="New workspace"
          detail={
            props.isolated ? "Separate files, tools and services" : "A separate copy for this task"
          }
          selected={isNew}
          onSelect={() => choose(() => props.onEnvModeChange("worktree"))}
        />
        <Row
          icon={<FolderIcon className="size-4 shrink-0" />}
          title="Project checkout"
          selected={!isNew && props.activeWorktreePath === null}
          onSelect={() =>
            choose(() =>
              props.onSelectWorkspace !== undefined
                ? props.onSelectWorkspace(null)
                : props.onEnvModeChange("local"),
            )
          }
        />
        {props.onSelectWorkspace !== undefined ? (
          <>
            <Input
              aria-label="Find workspace"
              placeholder="Find workspace…"
              size="compact"
              type="search"
              className="my-1.5"
              value={query}
              onValueChange={setQuery}
            />
            <div className="max-h-60 overflow-y-auto">
              {workspaces.map((workspace) => (
                <Row
                  key={workspace.key}
                  title={workspace.label}
                  detail={`${workspace.threadCount} ${workspace.threadCount === 1 ? "thread" : "threads"}${
                    workspace.runningCount > 0
                      ? ` · ${workspace.runningCount} running`
                      : workspace.settled
                        ? " · Settled"
                        : ""
                  }`}
                  selected={props.activeWorktreePath === workspace.path}
                  onSelect={() =>
                    choose(() =>
                      props.onSelectWorkspace?.({
                        path: workspace.path,
                        branch: workspace.branch,
                      }),
                    )
                  }
                />
              ))}
              {archive.isLoading ? (
                <p className="px-2 py-1.5 text-muted-foreground text-xs">
                  Loading settled workspaces…
                </p>
              ) : workspaces.length === 0 ? (
                <p className="px-2 py-1.5 text-muted-foreground text-xs">
                  {archive.error ?? "No matching workspaces."}
                </p>
              ) : null}
            </div>
            <label className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-xs">
              <Checkbox checked={showSettled} onCheckedChange={setShowSettled} />
              Show settled
            </label>
          </>
        ) : null}
        {props.isolated && isNew ? (
          <details className="mt-1 border-t px-2 pt-1.5 text-xs">
            <summary className="cursor-pointer text-muted-foreground">Advanced</summary>
            <div className="py-2">
              <RadioGroup
                aria-label="Agent setup"
                value={profile}
                onValueChange={(value) => setProfile(value === "minimal" ? "minimal" : "familiar")}
              >
                {(["familiar", "minimal"] as const).map((value) => (
                  <label key={value} className="flex items-start gap-2">
                    <Radio value={value} className="mt-0.5" />
                    <span>
                      {value === "familiar" ? "Familiar" : "Minimal"}
                      <span className="block text-muted-foreground">
                        {value === "familiar"
                          ? "Keeps your global instructions and skills"
                          : "Starts with the project's own instructions and tools"}
                      </span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </div>
          </details>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
});
