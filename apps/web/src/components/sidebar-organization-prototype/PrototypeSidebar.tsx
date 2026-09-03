/**
 * The prototype inbox: ordinary thread cards, coordinator cards with one
 * collapsible delegated-work tray each, and the Settled shelf. Every thread
 * has exactly one canonical row; deeper lineage is reduced to counts.
 */
import { SearchIcon } from "lucide-react";
import { Fragment, useMemo } from "react";

import { cn } from "~/lib/utils";
import { PROJECTS, type ProtoEffort, type ProtoThread } from "./data";
import {
  coordinatorTray,
  countMembers,
  countWork,
  countsLabel,
  effortMembers,
  isSuperseded,
  settledThreads,
  supersededChain,
  topLevelThreads,
  type Tray,
  type WorkIndex,
} from "./model";
import {
  DisclosureSlot,
  ProjectGlyph,
  SectionHeader,
  ShelfHeader,
  ThreadCardRow,
  ThreadSlimRow,
} from "./rows";
import { usePrototypeStore } from "./store";
import type { SidebarModel } from "./useSidebarModel";

function ancestorCoordinator(index: WorkIndex, thread: ProtoThread): ProtoThread | null {
  return thread.parentId === null ? null : (index.byId.get(thread.parentId) ?? null);
}

function searchContext(index: WorkIndex, thread: ProtoThread): string {
  const parts: string[] = [];
  const coordinator = ancestorCoordinator(index, thread);
  if (coordinator !== null) {
    const effort = thread.effortId === null ? undefined : index.effortById.get(thread.effortId);
    parts.push(
      effort === undefined
        ? `in ${coordinator.title}`
        : `in ${coordinator.title} › ${effort.title}`,
    );
  } else {
    parts.push(PROJECTS[thread.project].title);
  }
  if (thread.settled) parts.push("Settled");
  if (isSuperseded(index, thread)) parts.push("Superseded");
  return parts.join(" · ");
}

function SearchResults({ model, query }: { readonly model: SidebarModel; readonly query: string }) {
  const select = usePrototypeStore((s) => s.select);
  const needle = query.trim().toLowerCase();
  const results = [...model.index.byId.values()].filter((t) =>
    t.title.toLowerCase().includes(needle),
  );
  if (results.length === 0) {
    return (
      <p className="px-2.5 py-6 text-center text-sm text-sidebar-muted-foreground">
        No threads match.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-px" role="list">
      {results.map((thread) => (
        <ThreadSlimRow
          key={thread.id}
          thread={thread}
          index={model.index}
          active={model.selectedThreadId === thread.id}
          device={model.device}
          context={searchContext(model.index, thread)}
          dimmed={thread.settled || isSuperseded(model.index, thread)}
          onSelect={() => select(`thread:${thread.id}`)}
        />
      ))}
    </ul>
  );
}

/** A nested worker row, plus its earlier attempts when the reviewer opens them. */
function WorkerRow({
  model,
  thread,
}: {
  readonly model: SidebarModel;
  readonly thread: ProtoThread;
}) {
  const select = usePrototypeStore((s) => s.select);
  const { index, device } = model;
  const attempts = supersededChain(index, thread);
  const attemptsId = `attempts:${thread.id}`;
  const attemptsOpen = attempts.length > 0 && model.isExpanded(attemptsId);
  const childCounts = countWork(index, [thread.id]);
  const nestedSummary = countsLabel(childCounts);
  return (
    <Fragment>
      <ThreadSlimRow
        thread={thread}
        index={index}
        active={model.selectedThreadId === thread.id}
        device={device}
        onSelect={() => select(`thread:${thread.id}`)}
        {...(attempts.length === 0
          ? {}
          : {
              attemptsControl: {
                count: attempts.length,
                expanded: attemptsOpen,
                onToggle: () => model.toggle(attemptsId),
              },
            })}
        trailing={
          // One lineage hop: a nested coordinator shows its counts, never its own tray.
          nestedSummary === null ? undefined : (
            <span
              className={cn(
                "text-xs tabular-nums",
                childCounts.needsYou > 0
                  ? "text-amber-700 dark:text-amber-300"
                  : "text-secondary-label",
              )}
            >
              {nestedSummary}
            </span>
          )
        }
      />
      {attemptsOpen ? (
        <li className="ms-3 list-none border-s border-sidebar-border/50 ps-2">
          <ul className="flex flex-col gap-px" role="list">
            {attempts.map((attempt) => (
              <ThreadSlimRow
                key={attempt.id}
                thread={attempt}
                index={index}
                active={model.selectedThreadId === attempt.id}
                device={device}
                dimmed
                onSelect={() => select(`thread:${attempt.id}`)}
              />
            ))}
          </ul>
        </li>
      ) : null}
    </Fragment>
  );
}

function PastEffortRow({
  model,
  effort,
}: {
  readonly model: SidebarModel;
  readonly effort: ProtoEffort;
}) {
  const select = usePrototypeStore((s) => s.select);
  const members = effortMembers(model.index, effort);
  const done = members.filter(
    (m) => m.state === "completed" && !isSuperseded(model.index, m),
  ).length;
  const active = model.selectedId === `effort:${effort.id}`;
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={() => select(`effort:${effort.id}`)}
        className={cn(
          "flex w-full min-w-0 items-center gap-2.5 rounded-md px-2.5 text-left",
          model.device === "phone" ? "h-11" : "h-9",
          active
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            active ? "font-medium text-foreground" : "text-secondary-label/70",
          )}
        >
          {effort.title}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-secondary-label">
          {done} done · {members.length} thread{members.length === 1 ? "" : "s"}
        </span>
      </button>
    </li>
  );
}

function TrayBody({ model, tray }: { readonly model: SidebarModel; readonly tray: Tray }) {
  const { index, device } = model;
  const pastOpen = model.isExpanded(tray.pastContainerId);
  return (
    <div className="ms-3 mt-0.5 border-s border-sidebar-border/70 ps-2">
      <ul className="flex flex-col gap-px" role="list">
        {tray.bare.map((thread) => (
          <WorkerRow key={thread.id} model={model} thread={thread} />
        ))}
        {tray.sections.map((section) => {
          const expanded = model.isExpanded(section.containerId);
          const counts = countMembers(index, section.members);
          return (
            <Fragment key={section.containerId}>
              <SectionHeader
                title={section.title}
                device={device}
                expanded={expanded}
                onToggle={() => model.toggle(section.containerId)}
                closed={section.effort?.closed === true}
                summary={
                  countsLabel(counts, { includeDone: !expanded }) ??
                  (expanded ? null : `${section.members.length} idle`)
                }
                attention={counts.needsYou > 0}
              />
              {expanded ? (
                <li className="ms-2 list-none">
                  <ul className="flex flex-col gap-px" role="list">
                    {section.members.map((thread) => (
                      <WorkerRow key={thread.id} model={model} thread={thread} />
                    ))}
                  </ul>
                </li>
              ) : null}
            </Fragment>
          );
        })}
        {tray.pastEfforts.length > 0 ? (
          <Fragment>
            <SectionHeader
              title="Past efforts"
              device={device}
              expanded={pastOpen}
              onToggle={() => model.toggle(tray.pastContainerId)}
              summary={pastOpen ? null : String(tray.pastEfforts.length)}
              muted
            />
            {pastOpen ? (
              <li className="ms-2 list-none">
                <ul className="flex flex-col gap-px" role="list">
                  {tray.pastEfforts.map((effort) => (
                    <PastEffortRow key={effort.id} model={model} effort={effort} />
                  ))}
                </ul>
              </li>
            ) : null}
          </Fragment>
        ) : null}
      </ul>
    </div>
  );
}

function TopLevelRow({
  model,
  thread,
}: {
  readonly model: SidebarModel;
  readonly thread: ProtoThread;
}) {
  const select = usePrototypeStore((s) => s.select);
  const setExpanded = usePrototypeStore((s) => s.setExpanded);
  const { index, device } = model;
  const tray = coordinatorTray(index, thread.id);
  if (tray === null) {
    return (
      <ThreadCardRow
        thread={thread}
        index={index}
        active={model.selectedThreadId === thread.id}
        onSelect={() => select(`thread:${thread.id}`)}
      />
    );
  }
  const trayOpen = model.isExpanded(tray.containerId);
  const counts = countWork(index, [thread.id]);
  // The selected thread lives in this tray but some container on its path is
  // collapsed: say so on the coordinator instead of forcing the tray open.
  const placement = model.selectedPlacement;
  const hiddenSelected =
    placement !== null &&
    placement.coordinatorId === thread.id &&
    model.selectedThreadId !== null &&
    !placement.containers.every((id) => model.isExpanded(id))
      ? (index.byId.get(model.selectedThreadId) ?? null)
      : null;
  return (
    <Fragment>
      <ThreadCardRow
        thread={thread}
        index={index}
        active={model.selectedThreadId === thread.id}
        onSelect={() => select(`thread:${thread.id}`)}
        leading={
          <DisclosureSlot
            device={device}
            expanded={trayOpen}
            onToggle={() => model.toggle(tray.containerId)}
            label={trayOpen ? "Hide delegated work" : "Show delegated work"}
          />
        }
        summary={countsLabel(counts, { includeDone: !trayOpen })}
        summaryAttention={counts.needsYou > 0}
        viewing={hiddenSelected?.title ?? null}
        onRevealViewing={() => {
          if (placement === null) return;
          for (const id of placement.containers) setExpanded(device, id, true);
        }}
      />
      {trayOpen ? (
        <li className="list-none">
          <TrayBody model={model} tray={tray} />
        </li>
      ) : null}
    </Fragment>
  );
}

export function PrototypeSidebar({
  model,
  className,
}: {
  readonly model: SidebarModel;
  readonly className?: string;
}) {
  const select = usePrototypeStore((s) => s.select);
  const searchQuery = usePrototypeStore((s) => s.searchQuery);
  const setSearchQuery = usePrototypeStore((s) => s.setSearchQuery);
  const { index, device } = model;
  const active = useMemo(() => topLevelThreads(index), [index]);
  const settled = useMemo(() => settledThreads(index), [index]);
  const settledOpen = model.isExpanded("settled");
  const visibleSettled = settledOpen
    ? settled
    : settled.filter((t) => t.id === model.selectedThreadId);
  const searching = searchQuery.trim().length > 0;

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col bg-sidebar text-sidebar-foreground", className)}
      data-app-sidebar
    >
      <div className="relative z-[1] shrink-0 p-[var(--sidebar-content-inset)]">
        <label className="flex h-8 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
          <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder="Search"
            aria-label="Search threads"
            className="min-w-0 flex-1 bg-transparent text-sm font-medium text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[var(--sidebar-content-inset)] pb-6">
        {searching ? (
          <SearchResults model={model} query={searchQuery} />
        ) : (
          <ul className="flex flex-col" role="list">
            {active.map((thread) => (
              <TopLevelRow key={thread.id} model={model} thread={thread} />
            ))}
            {settled.length > 0 ? (
              <ShelfHeader
                label="Settled"
                count={settled.length}
                expanded={settledOpen}
                onToggle={() => model.toggle("settled")}
              />
            ) : null}
            {visibleSettled.map((thread) => (
              <ThreadSlimRow
                key={thread.id}
                thread={thread}
                index={index}
                active={model.selectedThreadId === thread.id}
                device={device}
                dimmed
                onSelect={() => select(`thread:${thread.id}`)}
                trailing={
                  <span className="text-xs tabular-nums text-secondary-label">{thread.age}</span>
                }
              />
            ))}
          </ul>
        )}
      </div>
      {searching ? null : (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-sidebar-border/60 px-3 py-1.5 text-[11px] text-sidebar-muted-foreground/70">
          <ProjectGlyph project="t3code" className="opacity-60" />
          {device === "phone" ? "Phone defaults" : "Desktop defaults"}
        </div>
      )}
    </div>
  );
}
