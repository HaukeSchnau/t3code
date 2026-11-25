import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { projectWorkspaceGroups, workspaceLabel } from "@t3tools/client-runtime/state/workspaces";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  FlaskConicalIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderIcon,
} from "lucide-react";
import { T, useGT } from "gt-react";
import { memo, useState } from "react";

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
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuItemLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSearchInput,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

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
  const icon = <Icon aria-hidden className="size-3 shrink-0" />;

  if (props.envLocked || props.forceNewWorktree) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              // The chips' 12px medium label at every size, as upstream's locked workspace chip.
              className="inline-flex h-7 min-w-0 shrink-0 items-center gap-1.25 border border-transparent px-2 text-caption text-muted-foreground sm:h-5.5 sm:text-meta"
              data-composer-context-control
              aria-label={label}
            />
          }
        >
          {icon}
          <ComposerContextLabel>{label}</ComposerContextLabel>
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
    );
  }

  const mode = isNew
    ? isolatedChoice
      ? "isolated"
      : "new"
    : props.activeWorktreePath === null
      ? "checkout"
      : "";
  const chooseMode = (value: string) => {
    setIsolatedWorkspaceChoice(value === "isolated");
    if (value !== "checkout") props.onEnvModeChange("worktree");
    else if (props.onSelectWorkspace !== undefined) props.onSelectWorkspace(null);
    else props.onEnvModeChange("local");
  };
  const chooseWorkspace = (path: string) => {
    const workspace = workspaces.find((candidate) => candidate.path === path);
    if (!workspace) return;
    setIsolatedWorkspaceChoice(false);
    props.onSelectWorkspace?.({ path: workspace.path, branch: workspace.branch });
  };
  return (
    <Menu open={open} onOpenChange={setOpen} modal={false}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<ComposerControl size="xs" />}
              data-pressed={open ? "" : undefined}
              className="min-w-0 shrink ps-2"
              aria-label={gt("Workspace: {workspace}", { workspace: label })}
              data-composer-context-control
              data-composer-shortcut="composer.workspace"
            />
          }
        >
          {icon}
          <ComposerContextLabel>{label}</ComposerContextLabel>
          <ChevronDownIcon
            aria-hidden
            data-composer-chevron
            className="size-2.5 shrink-0 text-muted-foreground"
          />
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup
        spacing="relaxed"
        align="start"
        side="top"
        // Workspace choices and names need a consistent width regardless of the chip label.
        className="w-90"
        {...composerFloatingLayerProps}
        data-composer-run-context
      >
        <MenuGroup>
          <MenuGroupLabel>
            <T>Workspace</T>
          </MenuGroupLabel>
          <MenuRadioGroup value={mode} onValueChange={(value) => chooseMode(String(value))}>
            <MenuRadioItem value="new" closeOnClick>
              <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="shrink-0">{gt("New workspace")}</span>
              <span className="min-w-0 truncate text-meta text-dim-foreground">
                {gt("A separate copy for this task")}
              </span>
            </MenuRadioItem>
            {props.isolated ? (
              <MenuRadioItem value="isolated" closeOnClick>
                <FlaskConicalIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0">{gt("New isolated workspace")}</span>
                <span className="min-w-0 truncate text-meta text-dim-foreground">
                  {gt("A clean room that can't see your other projects")}
                </span>
              </MenuRadioItem>
            ) : null}
            <MenuRadioItem value="checkout" closeOnClick>
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="shrink-0">{gt("Project checkout")}</span>
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        {props.onSelectWorkspace !== undefined ? (
          <>
            <MenuSeparator />
            <MenuSearchInput
              aria-label={gt("Find workspace")}
              placeholder={gt("Find workspace…")}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            <MenuGroup className="max-h-60 overflow-y-auto">
              <MenuRadioGroup
                value={props.activeWorktreePath ?? ""}
                onValueChange={(value) => chooseWorkspace(String(value))}
              >
                {workspaces.map((workspace) => (
                  <MenuRadioItem key={workspace.key} value={workspace.path} closeOnClick>
                    <FolderGitIcon className="size-4 shrink-0 text-muted-foreground" />
                    <MenuItemLabel>{workspace.label}</MenuItemLabel>
                    <MenuItemDetail>
                      {gt("{count, plural, one {{count} thread} other {{count} threads}}", {
                        count: workspace.threadCount,
                      })}
                    </MenuItemDetail>
                    {workspace.runningCount > 0 ? (
                      <span className="shrink-0 text-meta text-dim-foreground">
                        {gt("{count} running", { count: workspace.runningCount })}
                      </span>
                    ) : workspace.settled ? (
                      <span className="shrink-0 text-meta text-dim-foreground">
                        {gt("Settled", { $context: "workspace whose threads are all settled" })}
                      </span>
                    ) : null}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              {archive.isLoading ? (
                <MenuItem disabled>
                  <T>Loading settled workspaces…</T>
                </MenuItem>
              ) : workspaces.length === 0 ? (
                <MenuItem disabled>{archive.error ?? gt("No matching workspaces.")}</MenuItem>
              ) : null}
            </MenuGroup>
            <MenuCheckboxItem
              checked={showSettled}
              closeOnClick={false}
              onCheckedChange={setShowSettled}
            >
              <T>Show settled</T>
            </MenuCheckboxItem>
          </>
        ) : null}
        {isolatedChoice && isNew ? (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>
                <T>Clean room setup</T>
              </MenuGroupLabel>
              <MenuRadioGroup
                aria-label={gt("Agent setup")}
                value={profile}
                onValueChange={(value) => setProfile(value === "minimal" ? "minimal" : "familiar")}
              >
                {(["familiar", "minimal"] as const).map((value) => (
                  <MenuRadioItem key={value} value={value} closeOnClick={false}>
                    <span className="shrink-0">
                      {value === "familiar"
                        ? gt("Familiar", { $context: "clean room agent setup" })
                        : gt("Minimal", { $context: "clean room agent setup" })}
                    </span>
                    <span className="min-w-0 truncate text-meta text-dim-foreground">
                      {value === "familiar"
                        ? gt("Keeps your global instructions and skills")
                        : gt("Starts with the project's own instructions and tools")}
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
