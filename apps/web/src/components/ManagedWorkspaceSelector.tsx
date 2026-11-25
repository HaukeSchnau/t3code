import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { projectWorkspaceGroups, workspaceLabel } from "@t3tools/client-runtime/state/workspaces";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  FlaskConicalIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
} from "lucide-react";
import { T, useGT } from "gt-react";
import { memo, type ReactNode, useState } from "react";

import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import {
  setIsolatedWorkspaceChoice,
  useIsolatedWorkspaceChoice,
  useWorkspaceProfile,
} from "../lib/managedWorkspaces";
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
 * The composer's workspace picker on servers with managed workspaces
 * (patches/workspaces.md). Settled workspaces stay findable through search and
 * Show settled, which load archived threads on demand.
 */
export const ManagedWorkspaceSelector = memo(function ManagedWorkspaceSelector(
  props: ManagedWorkspaceSelectorProps,
) {
  const gt = useGT();
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [showSettled, setShowSettled] = useState(false);
  const [profile, setProfile] = useWorkspaceProfile();
  const isolatedChoice = useIsolatedWorkspaceChoice() && props.isolated;
  const projectRefs = open ? [scopeProjectRef(props.environmentId, props.projectId)] : [];
  const threads = useThreadShellsForProjectRefs(projectRefs);
  const archiveEnvironmentIds =
    open && (showSettled || query.trim().length > 0)
      ? [props.environmentId]
      : EMPTY_ENVIRONMENT_IDS;
  const archive = useArchivedThreadSnapshots(archiveEnvironmentIds);
  const workspaces = projectWorkspaceGroups({
    projectId: props.projectId,
    threads,
    archived: archive.snapshots,
    query,
    showSettled,
  });

  const isNew = props.effectiveEnvMode === "worktree" && props.activeWorktreePath === null;
  const label = props.forceNewWorktree
    ? gt("New workspace per model")
    : props.activeWorktreePath
      ? workspaceLabel(props.activeWorktreePath)
      : isNew
        ? isolatedChoice
          ? gt("New isolated workspace")
          : gt("New workspace")
        : gt("Project checkout");
  const Icon = props.activeWorktreePath
    ? FolderGitIcon
    : isNew
      ? isolatedChoice
        ? FlaskConicalIcon
        : FolderGit2Icon
      : FolderIcon;
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

  const choose = (action: () => void, isolated = false) => {
    setIsolatedWorkspaceChoice(isolated);
    action();
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<ComposerControl size="xs" />}
        aria-label={gt("Workspace")}
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
        <div className="px-2 pb-1 font-medium text-xs">
          <T>Workspace</T>
        </div>
        <Row
          icon={<FolderGit2Icon className="size-4 shrink-0" />}
          title={gt("New workspace")}
          detail={gt("A separate copy for this task")}
          selected={isNew && !isolatedChoice}
          onSelect={() => choose(() => props.onEnvModeChange("worktree"))}
        />
        {props.isolated ? (
          <Row
            icon={<FlaskConicalIcon className="size-4 shrink-0" />}
            title={gt("New isolated workspace")}
            detail={gt("A clean room that can't see your other projects")}
            selected={isNew && isolatedChoice}
            onSelect={() => choose(() => props.onEnvModeChange("worktree"), true)}
          />
        ) : null}
        <Row
          icon={<FolderIcon className="size-4 shrink-0" />}
          title={gt("Project checkout")}
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
              aria-label={gt("Find workspace")}
              placeholder={gt("Find workspace…")}
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
                  detail={[
                    gt("{count, plural, one {{count} thread} other {{count} threads}}", {
                      count: workspace.threadCount,
                    }),
                    ...(workspace.runningCount > 0
                      ? [gt("{count} running", { count: workspace.runningCount })]
                      : workspace.settled
                        ? [gt("Settled", { $context: "workspace whose threads are all settled" })]
                        : []),
                  ].join(" · ")}
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
                  <T>Loading settled workspaces…</T>
                </p>
              ) : workspaces.length === 0 ? (
                <p className="px-2 py-1.5 text-muted-foreground text-xs">
                  {archive.error ?? gt("No matching workspaces.")}
                </p>
              ) : null}
            </div>
            <label className="flex items-center gap-2 px-2 py-1.5 text-muted-foreground text-xs">
              <Checkbox checked={showSettled} onCheckedChange={setShowSettled} />
              <T>Show settled</T>
            </label>
          </>
        ) : null}
        {isolatedChoice && isNew ? (
          <details className="mt-1 border-t px-2 pt-1.5 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              <T>Clean room setup</T>
            </summary>
            <div className="py-2">
              <RadioGroup
                aria-label={gt("Agent setup")}
                value={profile}
                onValueChange={(value) => setProfile(value === "minimal" ? "minimal" : "familiar")}
              >
                {(["familiar", "minimal"] as const).map((value) => (
                  <label key={value} className="flex items-start gap-2">
                    <Radio value={value} className="mt-0.5" />
                    <span>
                      {value === "familiar"
                        ? gt("Familiar", { $context: "clean room agent setup" })
                        : gt("Minimal", { $context: "clean room agent setup" })}
                      <span className="block text-muted-foreground">
                        {value === "familiar"
                          ? gt("Keeps your global instructions and skills")
                          : gt("Starts with the project's own instructions and tools")}
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
