/**
 * The prototype inbox. Project groups are the root disclosure; inside them
 * every thread is the same row, coordinators carry one collapsible
 * delegated-work tray, and settled threads sit on the group's Settled shelf.
 * Every thread has exactly one canonical row; deeper lineage is reduced to
 * counts. Collapsed containers that hide the selected row say so with a
 * Viewing line instead of opening themselves.
 */
import { SearchIcon } from "lucide-react";
import { Fragment, useMemo } from "react";

import { cn } from "~/lib/utils";
import { PROJECTS, type ProtoEffort, type ProtoThread } from "./data";
import {
  coordinatorTray,
  countGroup,
  countMembers,
  countWork,
  countsLabel,
  effortMembers,
  isSuperseded,
  projectGroups,
  supersededChain,
  type ProjectGroup,
  type Tray,
  type WorkIndex,
} from "./model";
import {
  branchLabel,
  DisclosureSlot,
  ProjectHeader,
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

/** Subtitle for a thread row in its canonical place: the branch, or a coordinator's delegated-work counts. */
function rowSubtitle(
  index: WorkIndex,
  thread: ProtoThread,
): { readonly text: string; readonly attention: boolean } {
  if ((index.childrenOf.get(thread.id)?.length ?? 0) > 0) {
    const counts = countWork(index, [thread.id]);
    return {
      text: countsLabel(counts, { includeDone: true }) ?? "No live delegated work",
      attention: counts.needsYou > 0,
    };
  }
  if (isSuperseded(index, thread)) return { text: "Earlier attempt", attention: false };
  return { text: branchLabel(thread), attention: false };
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
        <ThreadRow
          key={thread.id}
          thread={thread}
          index={model.index}
          active={model.selectedThreadId === thread.id}
          subtitle={searchContext(model.index, thread)}
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
  const subtitle = rowSubtitle(index, thread);
  return (
    <Fragment>
      <ThreadRow
        thread={thread}
        index={index}
        active={model.selectedThreadId === thread.id}
        subtitle={subtitle.text}
        subtitleAttention={subtitle.attention}
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
        <li className="ms-3 list-none border-s border-sidebar-border/50 ps-2">
          <ul className="flex flex-col" role="list">
            {attempts.map((attempt) => (
              <ThreadRow
                key={attempt.id}
                thread={attempt}
                index={index}
                active={model.selectedThreadId === attempt.id}
                subtitle={rowSubtitle(index, attempt).text}
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

function TrayBody({ model, tray }: { readonly model: SidebarModel; readonly tray: Tray }) {
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
              <li className="ms-2 list-none">
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

/** Title of the selected thread when it sits under `ownerId` but some container on its path is collapsed. */
function hiddenSelectedTitle(model: SidebarModel, ownsSelection: boolean): string | null {
  const placement = model.selectedPlacement;
  if (!ownsSelection || placement === null || model.selectedThreadId === null) return null;
  if (placement.containers.every((id) => model.isExpanded(id))) return null;
  return model.index.byId.get(model.selectedThreadId)?.title ?? null;
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
  const subtitle = rowSubtitle(index, thread);
  if (tray === null) {
    return (
      <ThreadRow
        thread={thread}
        index={index}
        active={model.selectedThreadId === thread.id}
        subtitle={subtitle.text}
        onSelect={() => select(`thread:${thread.id}`)}
      />
    );
  }
  const trayOpen = model.isExpanded(tray.containerId);
  const viewing = hiddenSelectedTitle(model, model.selectedPlacement?.coordinatorId === thread.id);
  return (
    <Fragment>
      <ThreadRow
        thread={thread}
        index={index}
        active={model.selectedThreadId === thread.id}
        subtitle={subtitle.text}
        subtitleAttention={subtitle.attention}
        onSelect={() => select(`thread:${thread.id}`)}
        leading={
          <DisclosureSlot
            device={device}
            expanded={trayOpen}
            onToggle={() => model.toggle(tray.containerId)}
            label={trayOpen ? "Hide delegated work" : "Show delegated work"}
          />
        }
      />
      {viewing !== null ? (
        <ViewingRow
          title={viewing}
          device={device}
          onReveal={() => {
            for (const id of model.selectedPlacement?.containers ?? [])
              setExpanded(device, id, true);
          }}
        />
      ) : null}
      {trayOpen ? (
        <li className="list-none">
          <TrayBody model={model} tray={tray} />
        </li>
      ) : null}
    </Fragment>
  );
}

function groupSummary(
  index: WorkIndex,
  group: ProjectGroup,
): { readonly text: string; readonly attention: boolean } {
  const counts = countGroup(index, group);
  const parts = [`${counts.threads} thread${counts.threads === 1 ? "" : "s"}`];
  const live = countsLabel(counts);
  if (live !== null) parts.push(live);
  return { text: parts.join(" · "), attention: counts.needsYou > 0 };
}

function ProjectGroupBlock({
  model,
  group,
}: {
  readonly model: SidebarModel;
  readonly group: ProjectGroup;
}) {
  const select = usePrototypeStore((s) => s.select);
  const setExpanded = usePrototypeStore((s) => s.setExpanded);
  const { index, device } = model;
  const expanded = model.isExpanded(group.containerId);
  const settledOpen = model.isExpanded(group.settledContainerId);
  const summary = groupSummary(index, group);
  const ownsSelection = model.selectedPlacement?.containers[0] === group.containerId;
  const viewing = expanded ? null : hiddenSelectedTitle(model, ownsSelection);
  const visibleSettled = settledOpen
    ? group.settled
    : group.settled.filter((t) => t.id === model.selectedThreadId);
  return (
    <Fragment>
      <ProjectHeader
        project={group.project}
        device={device}
        expanded={expanded}
        onToggle={() => model.toggle(group.containerId)}
        summary={expanded ? null : summary.text}
        attention={!expanded && summary.attention}
      />
      {viewing !== null ? (
        <ViewingRow
          title={viewing}
          device={device}
          onReveal={() => {
            for (const id of model.selectedPlacement?.containers ?? []) {
              if (!id.startsWith("settled:")) setExpanded(device, id, true);
            }
          }}
        />
      ) : null}
      {expanded ? (
        <li className="list-none">
          <ul className="ms-2 flex flex-col border-s border-sidebar-border/70 ps-1" role="list">
            {group.roots.map((thread) => (
              <TopLevelRow key={thread.id} model={model} thread={thread} />
            ))}
            {group.settled.length > 0 ? (
              <ShelfHeader
                label="Settled"
                count={group.settled.length}
                expanded={settledOpen}
                onToggle={() => model.toggle(group.settledContainerId)}
              />
            ) : null}
            {visibleSettled.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                index={index}
                active={model.selectedThreadId === thread.id}
                subtitle={rowSubtitle(index, thread).text}
                onSelect={() => select(`thread:${thread.id}`)}
              />
            ))}
          </ul>
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
  const searchQuery = usePrototypeStore((s) => s.searchQuery);
  const setSearchQuery = usePrototypeStore((s) => s.setSearchQuery);
  const { index, device } = model;
  const groups = useMemo(() => projectGroups(index), [index]);
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
          <ul className="flex flex-col gap-1" role="list">
            {groups.map((group) => (
              <ProjectGroupBlock key={group.project} model={model} group={group} />
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
