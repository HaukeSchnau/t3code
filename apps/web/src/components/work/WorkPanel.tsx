/**
 * Work: the right-panel surface for durable peer threads a coordinator
 * delegated to. Separate from Agents, which shows a provider's ephemeral
 * subagents inside one thread.
 *
 * Reads only shell data plus the coordination lineage, so it costs nothing
 * for ordinary threads and never hydrates a transcript. Rows are canonical
 * threads: every action opens the real thread or one of its real surfaces.
 * Compare is a mode entered from a multi-selection.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  coordinationCountsLabel,
  countWorkers,
  groupChildrenByEffort,
  openWaitsOf,
  openWatchesOf,
  resolveWorkerState,
  rootCoordinatorKey,
  type ScopedEffort,
  type ScopedWait,
  type ScopedWatch,
  type ThreadLineage,
  type WorkerState,
} from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Ellipsis, Hourglass, RadioTower } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import {
  deriveProviderEntriesByEnvironment,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useRightPanelStore } from "../../rightPanelStore";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { useThreadLineage } from "../../state/coordination";
import { useServerConfigs, useThreadShells } from "../../state/entities";
import { cn } from "~/lib/utils";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { CompareSurface } from "./CompareSurface";
import { useProductionWorkActions } from "./workActions";
import { useWorkPanelStore } from "./workPanelStore";
import {
  formatElapsed,
  workerActivityLine,
  workerElapsed,
  workerStateVisual,
} from "./workPresentation";

/**
 * Human corrections. Optional because the server verbs behind them ship
 * separately; without them the panel is read-only and still honest.
 */
export interface WorkActions {
  readonly moveToEffort?: (ref: ScopedThreadRef, effortId: string | null) => void;
  readonly closeEffort?: (effortId: string, stopMembers: boolean) => void;
  readonly reopenEffort?: (effortId: string) => void;
  readonly cancelWait?: (waitId: string) => void;
  readonly cancelWatch?: (watchId: string) => void;
  readonly stopThread?: (ref: ScopedThreadRef) => void;
  readonly retryThread?: (ref: ScopedThreadRef) => void;
}

interface WorkContext {
  readonly lineage: ThreadLineage;
  readonly shellsByKey: ReadonlyMap<string, EnvironmentThreadShell>;
  readonly providerEntries: ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>>;
  readonly rootKey: string;
  readonly focusedKey: string;
  readonly now: string;
  readonly actions: WorkActions;
}

function stateOf(context: WorkContext, key: string): WorkerState | null {
  const shell = context.shellsByKey.get(key);
  return shell === undefined ? null : resolveWorkerState(shell);
}

function labelOf(context: WorkContext, key: string): string {
  return context.lineage.entries.get(key)?.label ?? context.shellsByKey.get(key)?.title ?? key;
}

function useOpenThread() {
  const navigate = useNavigate();
  return useCallback(
    (ref: ScopedThreadRef, surface?: "diff" | "files" | "browser") => {
      if (surface === "browser") useRightPanelStore.getState().openBrowser(ref, null);
      else if (surface !== undefined) useRightPanelStore.getState().open(ref, surface);
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: ref.environmentId, threadId: ref.threadId },
      });
    },
    [navigate],
  );
}

const WorkRow = memo(function WorkRow({
  context,
  threadKey,
  depth,
}: {
  readonly context: WorkContext;
  readonly threadKey: string;
  readonly depth: number;
}) {
  const openThread = useOpenThread();
  const selected = useWorkPanelStore((store) => store.selectedKeys.includes(threadKey));
  const toggleSelected = useWorkPanelStore((store) => store.toggleSelected);
  const shell = context.shellsByKey.get(threadKey);
  const entry = context.lineage.entries.get(threadKey);
  if (shell === undefined) return null;
  const ref: ScopedThreadRef = { environmentId: shell.environmentId, threadId: shell.id };
  const state = resolveWorkerState(shell);
  const visual = workerStateVisual(state);
  const replaced = entry?.replacedByKey != null;
  const live = state === "working" || state === "blocked";
  const focused = threadKey === context.focusedKey;
  const providerEntry =
    context.providerEntries.get(shell.environmentId)?.get(shell.modelSelection.instanceId) ?? null;
  const model = providerEntry?.models.find(
    (candidate) => candidate.slug === shell.modelSelection.model,
  );
  const metadata = [
    providerEntry?.displayName ?? null,
    model ? getTriggerDisplayModelLabel(model) : shell.modelSelection.model,
    shell.branch,
  ].filter((value): value is string => value !== null && value.length > 0);
  const activity = workerActivityLine(shell, state);
  const elapsed = workerElapsed(shell, context.now);
  const effort =
    entry?.effortId == null
      ? undefined
      : context.lineage.efforts.find((candidate) => candidate.effortId === entry.effortId);
  const otherEfforts = (context.lineage.effortsByCoordinatorKey.get(context.rootKey) ?? []).filter(
    (candidate) => candidate.closedAt === null && candidate.effortId !== entry?.effortId,
  );
  const children = (entry?.childKeys ?? []).filter((key) => context.shellsByKey.has(key));
  const { actions } = context;
  const canMove =
    depth === 0 &&
    actions.moveToEffort !== undefined &&
    (otherEfforts.length > 0 || effort !== undefined);

  return (
    <li className={cn(depth > 0 && "ms-3 border-s border-border/60 ps-1.5")}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => openThread(ref)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openThread(ref);
          }
        }}
        data-selected={selected || undefined}
        data-testid="work-row"
        className={cn(
          "group/work-row grid h-[3.875rem] cursor-pointer grid-cols-[1rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
          focused && "bg-accent/60",
          selected && "bg-sidebar-row-selected",
          replaced && "opacity-60",
        )}
      >
        <span
          className="col-start-1 row-start-1 flex items-center justify-center"
          onClick={(event) => event.stopPropagation()}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full group-hover/work-row:hidden",
              visual.dotClass,
              selected && "hidden",
            )}
          />
          <Checkbox
            aria-label={`Select ${labelOf(context, threadKey)}`}
            checked={selected}
            onCheckedChange={() => toggleSelected(threadKey)}
            className={cn(
              "size-3.5 sm:size-3.5",
              selected ? "inline-flex" : "hidden group-hover/work-row:inline-flex",
            )}
          />
        </span>
        <span className="col-start-2 row-start-1 flex min-w-0 items-center gap-2">
          {providerEntry ? (
            <ProviderInstanceIcon
              instanceId={providerEntry.instanceId}
              driverKind={providerEntry.driverKind}
              displayName={providerEntry.displayName}
              accentColor={providerEntry.accentColor}
              iconClassName="size-3.5 opacity-70"
            />
          ) : null}
          <span className={cn("min-w-0 truncate text-sm font-medium", replaced && "line-through")}>
            {shell.title}
          </span>
          {entry?.label && entry.label !== shell.title ? (
            <span className="max-w-32 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground">
              {entry.label}
            </span>
          ) : null}
          {replaced ? (
            <span className="shrink-0 rounded-sm border border-border/60 px-1 font-mono text-[.6rem] text-muted-foreground">
              replaced
            </span>
          ) : null}
        </span>
        <span className="col-start-3 row-start-1 flex min-w-14 items-center justify-end gap-1 font-mono text-[.7rem] text-muted-foreground/80">
          <span className="tabular-nums group-hover/work-row:hidden">{elapsed ?? ""}</span>
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost-muted"
                  aria-label={`Actions for ${shell.title}`}
                  className="hidden group-hover/work-row:inline-flex data-[popup-open]:inline-flex"
                  onClick={(event) => event.stopPropagation()}
                />
              }
            >
              <Ellipsis aria-hidden className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => openThread(ref)}>Open thread</MenuItem>
              <MenuItem onClick={() => openThread(ref, "diff")}>Open diff</MenuItem>
              <MenuItem onClick={() => openThread(ref, "files")}>Open files</MenuItem>
              <MenuItem onClick={() => openThread(ref, "browser")}>Open preview</MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => toggleSelected(threadKey)}>
                {selected ? "Deselect" : "Select for Compare"}
              </MenuItem>
              {live && actions.stopThread ? (
                <MenuItem onClick={() => actions.stopThread?.(ref)}>Stop</MenuItem>
              ) : null}
              {!replaced && (state === "failed" || state === "stopped") && actions.retryThread ? (
                <MenuItem onClick={() => actions.retryThread?.(ref)}>
                  Retry with a new worker
                </MenuItem>
              ) : null}
              {canMove ? (
                <>
                  <MenuSeparator />
                  <MenuGroup>
                    <MenuGroupLabel>Move to</MenuGroupLabel>
                    {otherEfforts.map((candidate) => (
                      <MenuItem
                        key={candidate.effortId}
                        onClick={() => actions.moveToEffort?.(ref, candidate.effortId)}
                      >
                        {candidate.title}
                      </MenuItem>
                    ))}
                    {effort !== undefined ? (
                      <MenuItem onClick={() => actions.moveToEffort?.(ref, null)}>
                        No effort
                      </MenuItem>
                    ) : null}
                  </MenuGroup>
                </>
              ) : null}
            </MenuPopup>
          </Menu>
        </span>
        <span
          className={cn(
            "col-start-2 col-end-4 row-start-2 block truncate text-xs",
            state === "failed"
              ? "text-destructive-foreground"
              : state === "blocked"
                ? "text-amber-700 dark:text-amber-300"
                : "text-muted-foreground",
          )}
        >
          {activity ?? visual.label}
        </span>
        <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70">
          {metadata.join(" · ")}
        </span>
        <span className="sr-only">{visual.label}</span>
      </div>
      {children.length > 0 ? (
        <ul className="flex flex-col">
          {children.map((childKey) => (
            <WorkRow key={childKey} context={context} threadKey={childKey} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
});

function WaitRow({ context, wait }: { readonly context: WorkContext; readonly wait: ScopedWait }) {
  const names = wait.memberKeys.map((key) => labelOf(context, key));
  const done = wait.members.filter((member) =>
    ["completed", "failed", "interrupted"].includes(member.outcome ?? ""),
  ).length;
  const blocked = wait.memberKeys.filter((key, index) => {
    const outcome = wait.members[index]?.outcome;
    return (
      outcome === "blocked-approval" ||
      outcome === "blocked-input" ||
      stateOf(context, key) === "blocked"
    );
  });
  return (
    <div
      data-testid="work-wait"
      className={cn(
        "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
        blocked.length > 0
          ? "border-warning/40 bg-warning-surface/40"
          : "border-border/60 bg-card/30",
      )}
    >
      <Hourglass
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          blocked.length > 0 ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">Waiting on</span> {names.join(", ")}
        <span className="text-muted-foreground">
          {" "}
          · {wait.mode === "all" ? "all of" : "any of"} · {done} of {wait.memberKeys.length} done
        </span>
        {blocked.length > 0 ? (
          <span className="text-amber-700 dark:text-amber-300">
            {" "}
            · {blocked.map((key) => labelOf(context, key)).join(", ")} need
            {blocked.length === 1 ? "s" : ""} you
          </span>
        ) : null}
        {wait.deadlineAt !== null ? (
          <span className="text-muted-foreground">
            {" "}
            · deadline {formatElapsed(context.now, wait.deadlineAt)}
          </span>
        ) : null}
      </span>
      {context.actions.cancelWait ? (
        <Button
          size="compact"
          variant="ghost-muted"
          className="h-6 px-1.5 text-[.7rem]"
          onClick={() => context.actions.cancelWait?.(wait.waitId)}
        >
          Cancel wait
        </Button>
      ) : null}
    </div>
  );
}

function WatchRow({
  context,
  watch,
}: {
  readonly context: WorkContext;
  readonly watch: ScopedWatch;
}) {
  const source =
    watch.source.type === "websocket"
      ? watch.source.url
      : watch.source.type === "shell"
        ? watch.source.command
        : watch.source.argv.join(" ");
  return (
    <div
      data-testid="work-watch"
      className="flex items-center gap-2 rounded-md border border-border/60 bg-card/30 px-2.5 py-1.5 text-xs"
    >
      <RadioTower aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">Watching</span> {source}
        <span className="text-muted-foreground">
          {" "}
          · {watch.eventCount} event{watch.eventCount === 1 ? "" : "s"}
          {watch.policy.type === "model" ? " · filtered" : ""}
        </span>
      </span>
      {context.actions.cancelWatch ? (
        <Button
          size="compact"
          variant="ghost-muted"
          className="h-6 px-1.5 text-[.7rem]"
          onClick={() => context.actions.cancelWatch?.(watch.watchId)}
        >
          Cancel watch
        </Button>
      ) : null}
    </div>
  );
}

function EffortSection({
  context,
  effort,
  memberKeys,
}: {
  readonly context: WorkContext;
  readonly effort: ScopedEffort | null;
  readonly memberKeys: ReadonlyArray<string>;
}) {
  const collapsedIds = useWorkPanelStore((store) => store.collapsedEffortIds);
  const toggleCollapsed = useWorkPanelStore((store) => store.toggleEffortCollapsed);
  const setSelected = useWorkPanelStore((store) => store.setSelected);
  const [confirmClose, setConfirmClose] = useState(false);
  const closed = effort?.closedAt != null;
  const collapsed =
    effort === null ? false : collapsedIds.includes(effort.effortId) ? !closed : closed;
  const counts = countWorkers(context.lineage, memberKeys, (key) => stateOf(context, key));
  const label = coordinationCountsLabel(counts);
  const liveCount = memberKeys.filter((key) => {
    const state = stateOf(context, key);
    return state === "working" || state === "blocked";
  }).length;
  const dotClass = closed
    ? "bg-muted-foreground/50"
    : counts.blocked > 0 || counts.failed > 0
      ? "bg-warning"
      : counts.working > 0
        ? "bg-info"
        : "bg-success";
  const { actions } = context;

  return (
    <section
      data-testid="work-effort"
      className={cn("rounded-lg border border-border/50 bg-card/30 p-1.5", closed && "opacity-80")}
    >
      <div className="flex items-center gap-2 px-1.5 pt-0.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
        <span className="min-w-0 truncate">{effort?.title ?? "Delegated"}</span>
        {closed ? (
          <span className="rounded-sm border border-border/60 px-1 font-mono normal-case">
            closed
          </span>
        ) : null}
        <span className="ml-auto font-mono normal-case text-muted-foreground/80">
          {label ?? ""}
        </span>
        {effort !== null ? (
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={collapsed ? `Expand ${effort.title}` : `Collapse ${effort.title}`}
            onClick={() => toggleCollapsed(effort.effortId)}
          >
            {collapsed ? (
              <ChevronRight aria-hidden className="size-3" />
            ) : (
              <ChevronDown aria-hidden className="size-3" />
            )}
          </Button>
        ) : null}
      </div>
      {collapsed ? null : (
        <>
          <ul className="mt-1 flex flex-col">
            {memberKeys.map((key) => (
              <WorkRow key={key} context={context} threadKey={key} depth={0} />
            ))}
          </ul>
          <div className="mt-1 flex items-center gap-1 px-1.5 pb-0.5">
            {memberKeys.length > 1 ? (
              <Button
                size="compact"
                variant="ghost-muted"
                className="h-6 px-1.5 text-[.7rem]"
                onClick={() =>
                  setSelected(
                    memberKeys.filter(
                      (key) => context.lineage.entries.get(key)?.replacedByKey == null,
                    ),
                  )
                }
              >
                Select all
              </Button>
            ) : null}
            {effort !== null ? (
              <span className="ml-auto font-mono text-[.65rem] text-muted-foreground/70">
                {formatElapsed(effort.openedAt, effort.closedAt ?? context.now)}
              </span>
            ) : null}
            {effort !== null && closed && actions.reopenEffort ? (
              <Button
                size="compact"
                variant="ghost-muted"
                className="h-6 px-1.5 text-[.7rem]"
                onClick={() => actions.reopenEffort?.(effort.effortId)}
              >
                Reopen
              </Button>
            ) : null}
            {effort !== null && !closed && actions.closeEffort ? (
              <Button
                size="compact"
                variant="ghost-muted"
                className="h-6 px-1.5 text-[.7rem]"
                onClick={() =>
                  liveCount > 0
                    ? setConfirmClose(true)
                    : actions.closeEffort?.(effort.effortId, false)
                }
              >
                Close
              </Button>
            ) : null}
          </div>
        </>
      )}
      {effort !== null ? (
        <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Close {effort.title}?</AlertDialogTitle>
              <AlertDialogDescription>
                {liveCount} worker{liveCount === 1 ? " is" : "s are"} still running. Closing folds
                the effort in the sidebar and cancels waits that only cover its members.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button
                variant="outline"
                onClick={() => {
                  actions.closeEffort?.(effort.effortId, false);
                  setConfirmClose(false);
                }}
              >
                Close, keep running
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  actions.closeEffort?.(effort.effortId, true);
                  setConfirmClose(false);
                }}
              >
                Stop workers and close
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      ) : null}
    </section>
  );
}

export function WorkPanel({
  threadRef,
  actions: providedActions,
}: {
  readonly threadRef: ScopedThreadRef;
  /** Overrides the production corrections; the dev fixture routes them into its reducer. */
  readonly actions?: WorkActions;
}) {
  const productionActions = useProductionWorkActions();
  const actions = providedActions ?? productionActions;
  const lineage = useThreadLineage();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const narrow = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);
  const selectedKeys = useWorkPanelStore((store) => store.selectedKeys);
  const compareOpen = useWorkPanelStore((store) => store.compareOpen);
  const openCompare = useWorkPanelStore((store) => store.openCompare);
  const clearSelection = useWorkPanelStore((store) => store.clearSelection);

  const shellsByKey = useMemo(
    () =>
      new Map(
        threads.map((thread) => [
          scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id }),
          thread,
        ]),
      ),
    [threads],
  );
  const providerEntries = useMemo(
    () =>
      deriveProviderEntriesByEnvironment(
        [...serverConfigs].map(
          ([environmentId, config]) => [environmentId, config.providers] as const,
        ),
      ),
    [serverConfigs],
  );
  const focusedKey = scopedThreadKey(threadRef);
  const rootKey = rootCoordinatorKey(lineage, focusedKey);
  // One clock per commit: nothing in this panel ticks.
  const now = useMemo(() => new Date().toISOString(), [threads]);
  const context = useMemo<WorkContext>(
    () => ({ lineage, shellsByKey, providerEntries, rootKey, focusedKey, now, actions }),
    [lineage, shellsByKey, providerEntries, rootKey, focusedKey, now, actions],
  );

  const childKeys = (lineage.entries.get(rootKey)?.childKeys ?? []).filter((key) =>
    shellsByKey.has(key),
  );
  const groups = groupChildrenByEffort(lineage, rootKey, childKeys);
  const waits = openWaitsOf(lineage, rootKey);
  const watches = openWatchesOf(lineage, rootKey);
  const counts = countWorkers(lineage, childKeys, (key) => stateOf(context, key));
  const selectedRefs = selectedKeys.flatMap((key) => {
    const shell = shellsByKey.get(key);
    return shell === undefined ? [] : [{ environmentId: shell.environmentId, threadId: shell.id }];
  });

  if (compareOpen && selectedRefs.length >= 2) {
    return <CompareSurface refs={selectedRefs} narrow={narrow} />;
  }

  if (childKeys.length === 0 && waits.length === 0 && watches.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-muted-foreground">
        This thread has not delegated any work.
      </div>
    );
  }

  const root = shellsByKey.get(rootKey);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="work-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className="text-xs font-medium">Work</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {rootKey === focusedKey
            ? (coordinationCountsLabel(counts) ?? "")
            : `for ${root?.title ?? "coordinator"}`}
        </span>
      </div>
      {selectedRefs.length > 0 ? (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 bg-accent/40 px-3 text-xs">
          <span className="font-medium">{selectedRefs.length} selected</span>
          <Button
            size="compact"
            className="h-6 px-2 text-[.7rem]"
            disabled={selectedRefs.length < 2}
            onClick={openCompare}
          >
            Compare
          </Button>
          <Button
            size="compact"
            variant="ghost-muted"
            className="ml-auto h-6 px-1.5 text-[.7rem]"
            onClick={clearSelection}
          >
            Clear
          </Button>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-2">
          {waits.length > 0 ? (
            <section className="flex flex-col gap-1">
              <div className="flex items-center gap-2 px-1.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
                <Hourglass aria-hidden className="size-3" />
                Waiting
              </div>
              {waits.map((wait) => (
                <WaitRow key={wait.waitId} context={context} wait={wait} />
              ))}
            </section>
          ) : null}
          {watches.length > 0 ? (
            <section className="flex flex-col gap-1">
              <div className="flex items-center gap-2 px-1.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
                <RadioTower aria-hidden className="size-3" />
                Watching
              </div>
              {watches.map((watch) => (
                <WatchRow key={watch.watchId} context={context} watch={watch} />
              ))}
            </section>
          ) : null}
          {groups
            .filter((group) => group.effort === null || group.effort.closedAt === null)
            .map((group) => (
              <EffortSection
                key={group.effort?.effortId ?? "ungrouped"}
                context={context}
                effort={group.effort}
                memberKeys={group.memberKeys}
              />
            ))}
          {groups
            .filter((group) => group.effort !== null && group.effort.closedAt !== null)
            .map((group) => (
              <EffortSection
                key={group.effort?.effortId ?? "closed"}
                context={context}
                effort={group.effort}
                memberKeys={group.memberKeys}
              />
            ))}
        </div>
      </ScrollArea>
    </div>
  );
}
