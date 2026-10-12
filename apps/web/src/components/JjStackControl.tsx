import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  buildJjStackView,
  jjBreadcrumbParts,
  type JjStackRow,
  type JjStackView,
} from "@t3tools/client-runtime/state/vcs";
import type { EnvironmentId, JjAction, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { AlertTriangleIcon, ChevronDownIcon, EllipsisIcon, LayersIcon } from "lucide-react";
import { useState } from "react";

import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { resolveGitActionResultToastTiming } from "./GitActionsControl.logic";
import {
  JJ_FLAG_DESCRIPTIONS,
  jjActionToast,
  jjRowActions,
  jjStackActions,
} from "./JjStackControl.logic";
import { ComposerControl } from "./chat/ComposerControl";
import { JjThreadWorkDialogPopup } from "./JjThreadWorkDialog";
import { composerFloatingLayerProps, useComposerMenuProps } from "./chat/composerEventScope";
import { ThreadDetailsControl } from "./chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
} from "./chat/threadDetailsPanelStyles";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { Spinner } from "./ui/spinner";
import { Textarea } from "./ui/textarea";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const UNATTRIBUTED_PREVIEW_COUNT = 6;

type JjDialog =
  | { readonly kind: "describe"; readonly row: JjStackRow }
  | { readonly kind: "commit" }
  | { readonly kind: "bookmark"; readonly row: JjStackRow }
  | { readonly kind: "work" };

interface JjStackControlProps {
  readonly displayMode: "panel" | "toolbar";
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string;
  /** Opens the diff panel; shown as "View changes" in the stack popover. */
  readonly onOpenChanges?: () => void;
  /** Layout classes from the parent. */
  readonly className?: string;
}

/** The jj stack breadcrumb and the popover that acts on its changes. */
export function JjStackControl({
  displayMode,
  environmentId,
  threadId,
  cwd,
  onOpenChanges,
  className,
}: JjStackControlProps) {
  const threadRef = scopeThreadRef(environmentId, threadId);
  // Drafts have no server thread yet, so nothing in the stack belongs to them.
  const serverThreadRef = useThreadShell(threadRef) ? threadRef : null;
  const ownerThreadId = serverThreadRef ? threadId : null;
  const status = useEnvironmentQuery(vcsEnvironment.status({ environmentId, input: { cwd } }));
  const actions = useJjActions({ environmentId, cwd, threadId: ownerThreadId, serverThreadRef });
  const composerMenuProps = useComposerMenuProps();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<{ value: JjDialog; open: boolean; key: number } | null>(
    null,
  );

  const jj = status.data?.jj;
  if (!jj) return null;
  const view = buildJjStackView(jj, ownerThreadId);
  const isPanel = displayMode === "panel";
  const floatingLayerProps = isPanel ? {} : composerFloatingLayerProps;

  const openDialog = (value: JjDialog) => {
    setOpen(false);
    setDialog((previous) => ({ value, open: true, key: (previous?.key ?? 0) + 1 }));
  };
  const closeDialog = () => setDialog((previous) => previous && { ...previous, open: false });

  const breadcrumb = jjBreadcrumbParts(view).join(" › ");
  const conflictIndicator =
    view.conflictCount > 0 ? (
      <AlertTriangleIcon
        aria-label={
          view.conflictCount === 1
            ? "1 change has conflicts"
            : `${view.conflictCount} changes have conflicts`
        }
        className={cn("shrink-0 text-warning", isPanel ? "size-4" : "size-3")}
      />
    ) : null;

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) actions.refresh();
        }}
      >
        <div
          className={cn(
            "flex min-w-0",
            isPanel ? "w-full flex-col items-stretch" : "items-center",
            className,
          )}
        >
          {isPanel ? (
            <PopoverTrigger
              render={<ThreadDetailsControl part="select" />}
              className="min-w-0 max-w-full"
            >
              <LayersIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <ComposerContextLabel displayMode="panel">{breadcrumb}</ComposerContextLabel>
              {conflictIndicator}
              <span data-slot="select-icon">
                <ChevronDownIcon className={THREAD_DETAILS_PANEL_CHEVRON_CLASS} />
              </span>
            </PopoverTrigger>
          ) : (
            <PopoverTrigger render={<ComposerControl size="xs" />} className="min-w-0 max-w-full">
              <LayersIcon className="size-3 shrink-0 opacity-70" />
              <ComposerContextLabel>{breadcrumb}</ComposerContextLabel>
              {conflictIndicator}
              <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
            </PopoverTrigger>
          )}
        </div>
        <PopoverPopup
          width="lg"
          padding="compact"
          side={isPanel ? "bottom" : "top"}
          align={isPanel ? "start" : "end"}
          {...(isPanel ? {} : composerMenuProps)}
        >
          <JjStackPopoverBody
            view={view}
            hasTrunk={jj.trunk !== null}
            canAssign={ownerThreadId !== null}
            pending={actions.pending}
            floatingLayerProps={floatingLayerProps}
            onRun={(action) => void actions.run(action)}
            onAssign={(paths) => void actions.assign(paths)}
            onDialog={openDialog}
            {...(onOpenChanges
              ? {
                  onOpenChanges: () => {
                    setOpen(false);
                    onOpenChanges();
                  },
                }
              : {})}
          />
        </PopoverPopup>
      </Popover>
      <Dialog
        open={dialog?.open ?? false}
        onOpenChange={(next) => {
          if (!next) closeDialog();
        }}
      >
        {dialog?.value.kind === "work" && ownerThreadId !== null ? (
          <JjThreadWorkDialogPopup
            key={dialog.key}
            environmentId={environmentId}
            threadId={ownerThreadId}
          />
        ) : dialog && dialog.value.kind !== "work" ? (
          <JjDialogPopup
            key={dialog.key}
            dialog={dialog.value}
            onCancel={closeDialog}
            onSubmit={(action) => {
              closeDialog();
              void actions.run(action);
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}

function useJjActions(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadId: ThreadId | null;
  readonly serverThreadRef: ScopedThreadRef | null;
}) {
  const { environmentId, cwd, threadId, serverThreadRef } = input;
  const runAction = useAtomCommand(vcsEnvironment.jjRunAction, { reportFailure: false });
  const assignPaths = useAtomCommand(vcsEnvironment.jjAssignPaths, { reportFailure: false });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const openPrLink = useOpenPrLink(serverThreadRef ?? undefined);
  const [pending, setPending] = useState(false);
  const toastData = serverThreadRef ? { threadRef: serverThreadRef } : undefined;
  const refresh = () => void refreshStatus({ environmentId, input: { cwd } });

  const reportFailure = (cause: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "jj action failed",
        description: cause instanceof Error ? cause.message : "An error occurred.",
        timeout: resolveGitActionResultToastTiming("error").timeout,
        ...(toastData ? { data: toastData } : {}),
      }),
    );
  };

  const successToastOptions = () => {
    const timing = resolveGitActionResultToastTiming("success");
    return {
      timeout: timing.timeout,
      data: {
        ...toastData,
        ...(timing.dismissAfterVisibleMs !== null
          ? { dismissAfterVisibleMs: timing.dismissAfterVisibleMs }
          : {}),
      },
    };
  };

  const run = async (action: JjAction) => {
    setPending(true);
    const result = await runAction({
      environmentId,
      input: { cwd, action, ...(threadId ? { threadId } : {}) },
    });
    setPending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) reportFailure(squashAtomCommandFailure(result));
      return;
    }
    const toast = jjActionToast(result.value);
    const pullRequestUrl = result.value.pullRequestUrl;
    if (!pullRequestUrl) {
      toastManager.add({ ...toast, ...successToastOptions() });
      return;
    }
    const toastId = toastManager.add(
      stackedThreadToast({
        ...toast,
        ...successToastOptions(),
        actionProps: {
          children: "Open",
          onClick: (event) => {
            toastManager.close(toastId);
            openPrLink(event, pullRequestUrl);
          },
        },
      }),
    );
  };

  const assign = async (paths: ReadonlyArray<string>) => {
    if (threadId === null) return;
    setPending(true);
    const result = await assignPaths({ environmentId, input: { cwd, paths, threadId } });
    setPending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) reportFailure(squashAtomCommandFailure(result));
      return;
    }
    // Assigning records ownership only, so the server does not refresh status on its own.
    refresh();
    const count = result.value.assigned;
    toastManager.add({
      type: "success",
      title:
        count === 1 ? "Assigned 1 file to this thread" : `Assigned ${count} files to this thread`,
      ...successToastOptions(),
    });
  };

  return { pending, run, assign, refresh };
}

interface JjStackPopoverBodyProps {
  readonly view: JjStackView;
  readonly hasTrunk: boolean;
  readonly canAssign: boolean;
  readonly pending: boolean;
  readonly floatingLayerProps: Partial<typeof composerFloatingLayerProps>;
  readonly onRun: (action: JjAction) => void;
  readonly onAssign: (paths: ReadonlyArray<string>) => void;
  readonly onDialog: (dialog: JjDialog) => void;
  readonly onOpenChanges?: () => void;
}

function JjStackPopoverBody(props: JjStackPopoverBodyProps) {
  const { view, pending } = props;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-5 items-center gap-2 px-1">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          Stack on {view.base}
        </p>
        {view.conflictCount > 0 ? (
          <Badge variant="warning" size="sm">
            {view.conflictCount === 1 ? "1 conflict" : `${view.conflictCount} conflicts`}
          </Badge>
        ) : null}
        {pending ? <Spinner size="sm" tone="muted" /> : null}
      </div>
      {view.rows.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">No changes above {view.base}.</p>
      ) : (
        <ul className="flex flex-col">
          {view.rows.map((row) => (
            <JjStackRowItem key={row.changeId} row={row} {...props} />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1 border-t px-1 pt-2">
        {props.onOpenChanges ? (
          <Button size="xs" variant="outline" onClick={props.onOpenChanges}>
            View changes
          </Button>
        ) : null}
        {props.canAssign ? (
          <Button size="xs" variant="outline" onClick={() => props.onDialog({ kind: "work" })}>
            Work in other repositories
          </Button>
        ) : null}
        {jjStackActions(view, props.hasTrunk).map(({ label, action, disabled }) => (
          <Button
            key={label}
            size="xs"
            variant="outline"
            disabled={pending || disabled}
            onClick={() => props.onRun(action)}
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function JjStackRowItem({
  row,
  view,
  canAssign,
  pending,
  floatingLayerProps,
  onRun,
  onAssign,
  onDialog,
}: JjStackPopoverBodyProps & { readonly row: JjStackRow }) {
  const rowActions = jjRowActions(view, row);
  const showUnattributed = row.workingCopy && view.unattributed.length > 0;
  const hiddenUnattributed = view.unattributed.length - UNATTRIBUTED_PREVIEW_COUNT;
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-md px-1 py-1.5",
        row.ownership === "other-thread" && "opacity-60",
      )}
    >
      <span
        aria-hidden="true"
        className="w-3 shrink-0 text-center font-mono text-xs leading-5 text-muted-foreground"
      >
        {row.workingCopy ? "@" : "○"}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p
          className={cn(
            "truncate text-sm leading-5",
            row.undescribed && "italic text-muted-foreground",
          )}
        >
          {row.title}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          <code className="text-xs text-muted-foreground">{row.shortChangeId}</code>
          {row.empty ? <span className="text-xs text-muted-foreground">empty</span> : null}
          {row.turnLabel ? (
            <Badge variant="secondary" size="sm">
              {row.turnLabel}
            </Badge>
          ) : null}
          {row.bookmarks.map((bookmark) => (
            <Tooltip key={bookmark}>
              <TooltipTrigger
                render={<Badge variant={row.pushed ? "outline" : "info"} size="sm" />}
              >
                {row.pushed ? bookmark : `${bookmark} ↑`}
              </TooltipTrigger>
              <TooltipPopup>{row.pushed ? "Pushed" : "Not pushed yet"}</TooltipPopup>
            </Tooltip>
          ))}
          {row.conflict ? (
            <Badge variant="error" size="sm">
              conflict
            </Badge>
          ) : null}
          {row.flags.map((flag) => (
            <Tooltip key={flag}>
              <TooltipTrigger render={<Badge variant="warning" size="sm" />}>{flag}</TooltipTrigger>
              <TooltipPopup>{JJ_FLAG_DESCRIPTIONS[flag]}</TooltipPopup>
            </Tooltip>
          ))}
        </div>
        {showUnattributed ? (
          <div className="flex flex-col gap-1 pt-1">
            <p className="text-xs text-muted-foreground">
              {view.unattributed.length === 1
                ? "No turn claimed this file:"
                : `No turn claimed these ${view.unattributed.length} files:`}
            </p>
            <ul className="flex flex-col">
              {view.unattributed.slice(0, UNATTRIBUTED_PREVIEW_COUNT).map((path) => (
                <li key={path} className="truncate font-mono text-xs">
                  {path}
                </li>
              ))}
            </ul>
            {hiddenUnattributed > 0 ? (
              <p className="text-xs text-muted-foreground">and {hiddenUnattributed} more</p>
            ) : null}
            {canAssign ? (
              <Button
                size="xs"
                variant="outline"
                className="self-start"
                disabled={pending}
                onClick={() => onAssign(view.unattributed)}
              >
                Assign to this thread
              </Button>
            ) : null}
          </div>
        ) : null}
        {row.workingCopy && !row.empty ? (
          <Button
            size="xs"
            variant="outline"
            className="self-start"
            disabled={pending}
            onClick={() => onDialog({ kind: "commit" })}
          >
            Commit…
          </Button>
        ) : null}
      </div>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-micro"
              variant="ghost"
              aria-label={`Actions for ${row.shortChangeId}`}
              disabled={pending}
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end" {...floatingLayerProps}>
          <MenuItem onClick={() => onDialog({ kind: "describe", row })}>Describe…</MenuItem>
          <MenuItem
            disabled={!rowActions.squash}
            onClick={() => onRun({ _tag: "squash", changeId: row.changeId })}
          >
            Squash into parent
          </MenuItem>
          {rowActions.edit ? (
            <MenuItem onClick={() => onRun({ _tag: "edit", changeId: row.changeId })}>
              Edit
            </MenuItem>
          ) : null}
          <MenuItem onClick={() => onDialog({ kind: "bookmark", row })}>Bookmark…</MenuItem>
          <MenuSeparator />
          <MenuItem
            variant="destructive"
            onClick={() => onRun({ _tag: "abandon", changeId: row.changeId })}
          >
            Abandon
          </MenuItem>
        </MenuPopup>
      </Menu>
    </li>
  );
}

function JjDialogPopup({
  dialog,
  onCancel,
  onSubmit,
}: {
  readonly dialog: Exclude<JjDialog, { readonly kind: "work" }>;
  readonly onCancel: () => void;
  readonly onSubmit: (action: JjAction) => void;
}) {
  const [text, setText] = useState("");
  const value = text.trim();

  if (dialog.kind === "bookmark") {
    const { row } = dialog;
    const setBookmark = () => {
      if (value.length > 0) {
        onSubmit({ _tag: "bookmark", operation: "set", name: value, changeId: row.changeId });
      }
    };
    return (
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Bookmark {row.shortChangeId}</DialogTitle>
          <DialogDescription>
            {row.bookmarks.length > 0
              ? "Set a bookmark on this change, or rename or delete one it has."
              : "Set a bookmark on this change."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            aria-label="Bookmark name"
            placeholder="Bookmark name"
            autoCapitalize="none"
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") setBookmark();
            }}
          />
          {row.bookmarks.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {row.bookmarks.map((bookmark) => (
                <li key={bookmark} className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate text-sm">{bookmark}</code>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={value.length === 0 || value === bookmark}
                    onClick={() =>
                      onSubmit({
                        _tag: "bookmark",
                        operation: "rename",
                        name: bookmark,
                        newName: value,
                      })
                    }
                  >
                    Rename
                  </Button>
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    onClick={() =>
                      onSubmit({ _tag: "bookmark", operation: "delete", name: bookmark })
                    }
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={value.length === 0} onClick={setBookmark}>
            Set bookmark
          </Button>
        </DialogFooter>
      </DialogPopup>
    );
  }

  const message = value.length > 0 ? { message: value } : {};
  const copy =
    dialog.kind === "describe"
      ? {
          title: `Describe ${dialog.row.shortChangeId}`,
          description: "Replaces the change's description. Leave it empty and T3 writes one.",
          submit: "Describe",
          action: { _tag: "describe", changeId: dialog.row.changeId, ...message } as const,
        }
      : {
          title: "Commit the working copy",
          description:
            "Seals the working copy and starts a new change on top. Leave the message empty and T3 writes one.",
          submit: "Commit",
          action: { _tag: "commit", ...message } as const,
        };
  return (
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <Textarea
          aria-label="Message"
          placeholder="Message (optional)"
          size="sm"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </DialogPanel>
      <DialogFooter variant="bare">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => onSubmit(copy.action)}>
          {copy.submit}
        </Button>
      </DialogFooter>
    </DialogPopup>
  );
}
