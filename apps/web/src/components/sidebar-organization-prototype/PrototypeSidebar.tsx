/**
 * The prototype inbox. Rows are lineage roots in a flat list, each carrying
 * its project. A root with descendants owns one disclosure that hides its
 * whole subtree: effort sections, unassigned children, retries, and nested
 * coordinators (which show counts, never a tray of their own). Every thread
 * has exactly one canonical row; settled threads sit on the Settled shelf.
 * Collapsed containers that hide the selected row say so with a Viewing line
 * instead of opening themselves.
 */
import { SearchIcon } from "lucide-react";
import { Fragment, useMemo } from "react";

import { cn } from "~/lib/utils";
import { PROJECTS, type ProtoEffort, type ProtoThread } from "./data";
import {
  coordinatorTray,
  countDescendants,
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
  ROOT_INDENT_CLASS,
  RootDisclosure,
  SearchResultRow,
  SectionHeader,
  ShelfHeader,
  ThreadRow,
  ViewingRow,
} from "./rows";
import { usePrototypeStore } from "./store";
import type { SidebarModel } from "./useSidebarModel";

function searchContext(index: WorkIndex, thread: ProtoThread): string {
  const parts: string[] = [];
  const coordinator = thread.parentId === null ? undefined : index.byId.get(thread.parentId);
  if (coordinator !== undefined) {
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

/** Third line of a collapsed root: the recursive roll-up, attention first, hidden count last. */
function collapsedRootSummary(
  index: WorkIndex,
  rootId: string,
): { readonly text: string; readonly attention: boolean } {
  const counts = countWork(index, [rootId]);
  const parts = [countsLabel(counts, { includeDone: true }) ?? "no live delegated work"];
  parts.push(`${countDescendants(index, rootId)} hidden`);
  return { text: parts.join(" · "), attention: counts.needsYou > 0 };
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
    <ul className="flex flex-col" role="list">
      {results.map((thread) => (
        <SearchResultRow
          key={thread.id}
          thread={thread}
          active={model.selectedThreadId === thread.id}
          context={searchContext(model.index, thread)}
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
  const { index } = model;
  const attempts = supersededChain(index, thread);
  const attemptsId = `attempts:${thread.id}`;
  const attemptsOpen = attempts.length > 0 && model.isExpanded(attemptsId);
  return (
    <Fragment>
      <ThreadRow
        thread={thread}
        index={index}
        active={model.selectedThreadId === thread.id}
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
      />
      {attemptsOpen ? (
        <li className="ms-2.5 list-none border-s border-sidebar-border/50 ps-1.5">
          <ul className="flex flex-col" role="list">
            {attempts.map((attempt) => (
              <ThreadRow
                key={attempt.id}
                thread={attempt}
                index={index}
                active={model.selectedThreadId === attempt.id}
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
            : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            active ? "font-medium text-foreground" : "text-secondary-label",
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

/** Everything beneath a root: bare children, effort sections, and past efforts. */
function LineageBody({ model, tray }: { readonly model: SidebarModel; readonly tray: Tray }) {
  const { index, device } = model;
  const pastOpen = model.isExpanded(tray.pastContainerId);
  return (
    <div className="ms-2.5 border-s border-sidebar-border/70 ps-1.5">
      <ul className="flex flex-col" role="list">
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
                  expanded
                    ? null
                    : (countsLabel(counts, { includeDone: true }) ??
                      `${section.members.length} idle`)
                }
                attention={!expanded && counts.needsYou > 0}
              />
              {expanded ? (
                <li className="ms-1.5 list-none">
                  <ul className="flex flex-col" role="list">
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
              <li className="ms-1.5 list-none">
                <ul className="flex flex-col" role="list">
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

/** A lineage root: a full-width card when it never delegated, otherwise the card behind its disclosure gutter plus subtree. Only rows that own descendants pay for a gutter. */
function RootRow({
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
      <ThreadRow
        thread={thread}
        index={index}
        active={model.selectedThreadId === thread.id}
        onSelect={() => select(`thread:${thread.id}`)}
      />
    );
  }
  const open = model.isExpanded(tray.containerId);
  const summary = open ? null : collapsedRootSummary(index, thread.id);
  // The selected thread lives in this lineage but some container on its path
  // is collapsed: say so on the root instead of forcing anything open.
  const placement = model.selectedPlacement;
  const hiddenSelected =
    placement !== null &&
    placement.coordinatorId === thread.id &&
    model.selectedThreadId !== null &&
    !placement.containers.every((id) => model.isExpanded(id))
      ? (index.byId.get(model.selectedThreadId)?.title ?? null)
      : null;
  return (
    <Fragment>
      <ThreadRow
        thread={thread}
        index={index}
        active={model.selectedThreadId === thread.id}
        onSelect={() => select(`thread:${thread.id}`)}
        gutter={
          <RootDisclosure
            device={device}
            expanded={open}
            onToggle={() => model.toggle(tray.containerId)}
            label={`${open ? "Hide" : "Show"} delegated work for ${thread.title}`}
          />
        }
        {...(summary === null
          ? {}
          : { branchLine: summary.text, branchLineAttention: summary.attention })}
      />
      {hiddenSelected !== null ? (
        <li className={cn("flex list-none", ROOT_INDENT_CLASS)}>
          <ul className="min-w-0 flex-1" role="list">
            <ViewingRow
              title={hiddenSelected}
              device={device}
              onReveal={() => {
                for (const id of placement?.containers ?? []) setExpanded(device, id, true);
              }}
            />
          </ul>
        </li>
      ) : null}
      {open ? (
        <li className={cn("list-none", ROOT_INDENT_CLASS)}>
          <LineageBody model={model} tray={tray} />
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
  const roots = useMemo(() => topLevelThreads(index), [index]);
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
            {roots.map((thread) => (
              <RootRow key={thread.id} model={model} thread={thread} />
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
              <ThreadRow
                key={thread.id}
                thread={thread}
                index={index}
                active={model.selectedThreadId === thread.id}
                onSelect={() => select(`thread:${thread.id}`)}
              />
            ))}
          </ul>
        )}
      </div>
      {searching ? null : (
        <div className="flex shrink-0 items-center border-t border-sidebar-border/60 px-3 py-1.5 text-[11px] text-sidebar-muted-foreground/70">
          {device === "phone" ? "Phone defaults" : "Desktop defaults"}
        </div>
      )}
    </div>
  );
}
