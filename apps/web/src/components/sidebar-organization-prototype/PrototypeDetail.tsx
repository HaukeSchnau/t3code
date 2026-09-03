/**
 * Stand-in for the thread view: enough context to tell where the selected
 * row lives (coordinator, effort, replacement chain) and the settle/unsettle
 * reverse states, without pretending to be a transcript.
 */
import { ChevronRightIcon } from "lucide-react";

import { Button } from "../ui/button";
import { PROJECTS } from "./data";
import { effortMembers, isSuperseded, latestAttempt, supersededChain } from "./model";
import { threadStatus } from "./rows";
import { usePrototypeStore } from "./store";
import type { SidebarModel } from "./useSidebarModel";

function Crumb({ children }: { readonly children: React.ReactNode }) {
  return <span className="truncate text-muted-foreground">{children}</span>;
}

function Link({
  onClick,
  children,
}: {
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} className="text-info-foreground hover:underline">
      {children}
    </button>
  );
}

export function PrototypeDetail({ model }: { readonly model: SidebarModel }) {
  const select = usePrototypeStore((s) => s.select);
  const updateThread = usePrototypeStore((s) => s.updateThread);
  const { index, selectedId } = model;

  if (selectedId === null) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <p className="max-w-sm text-sm text-muted-foreground">
          Pick a row. The sidebar is the thing under test; this pane only shows where the selection
          lives.
        </p>
      </div>
    );
  }

  if (selectedId.startsWith("effort:")) {
    const effort = index.effortById.get(selectedId.slice(7));
    if (effort === undefined) return null;
    const coordinator = index.byId.get(effort.coordinatorId);
    const members = effortMembers(index, effort);
    return (
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-8">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          {coordinator ? (
            <>
              <Link onClick={() => select(`thread:${coordinator.id}`)}>{coordinator.title}</Link>
              <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            </>
          ) : null}
          <Crumb>Past effort</Crumb>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{effort.title}</h1>
        <p className="text-sm text-muted-foreground">
          Closed effort record. Members keep their single row on the Settled shelf; this record is
          the way back to them.
        </p>
        <ul className="flex flex-col gap-1 text-sm">
          {members.map((m) => (
            <li key={m.id} className="flex items-center gap-2">
              <Link onClick={() => select(`thread:${m.id}`)}>{m.title}</Link>
              <span className="text-xs text-muted-foreground">
                {isSuperseded(index, m) ? "superseded" : m.state} · {m.age}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const thread = index.byId.get(selectedId.slice(7));
  if (thread === undefined) return null;
  const coordinator = thread.parentId === null ? undefined : index.byId.get(thread.parentId);
  const effort = thread.effortId === null ? undefined : index.effortById.get(thread.effortId);
  const status = threadStatus(index, thread);
  const replacement = isSuperseded(index, thread) ? latestAttempt(index, thread) : null;
  const earlier = supersededChain(index, thread);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-6 py-8">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
        <Crumb>{PROJECTS[thread.project].title}</Crumb>
        {coordinator ? (
          <>
            <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <Link onClick={() => select(`thread:${coordinator.id}`)}>{coordinator.title}</Link>
          </>
        ) : null}
        {effort ? (
          <>
            <ChevronRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
            <Crumb>
              {effort.title}
              {effort.closed ? " (closed)" : ""}
            </Crumb>
          </>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight">{thread.title}</h1>
        <Button
          size="compact"
          variant="outline"
          onClick={() => updateThread(thread.id, { settled: !thread.settled, unread: false })}
        >
          {thread.settled ? "Unsettle" : "Settle"}
        </Button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Status</dt>
        <dd className={status?.className}>
          {status?.label ?? (thread.settled ? "Settled" : "Ready")}
        </dd>
        <dt className="text-muted-foreground">Sidebar row</dt>
        <dd>
          {thread.settled
            ? "Settled shelf"
            : replacement !== null
              ? "Behind its replacement"
              : coordinator
                ? `Inside ${coordinator.title}`
                : "Top level"}
        </dd>
        {replacement !== null ? (
          <>
            <dt className="text-muted-foreground">Superseded by</dt>
            <dd>
              <Link onClick={() => select(`thread:${replacement.id}`)}>{replacement.title}</Link>
            </dd>
          </>
        ) : null}
        {earlier.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Replaces</dt>
            <dd className="flex flex-col gap-0.5">
              {earlier.map((e) => (
                <Link key={e.id} onClick={() => select(`thread:${e.id}`)}>
                  {e.title}
                </Link>
              ))}
            </dd>
          </>
        ) : null}
      </dl>
      <p className="text-sm text-muted-foreground">
        Transcript omitted. Thread state changes come from the prototype panel; settling here moves
        the row to the Settled shelf.
      </p>
    </div>
  );
}
