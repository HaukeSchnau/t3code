/**
 * Transcript rows for coordinator and worker threads.
 *
 * Messages render through the real markdown component. Orchestration facts
 * render as compact rows matched to the density of the native subagent spawn
 * row: an effort card at the launch that opened it, one-line notes for later
 * launches and corrections, a wait row with its actions, and quiet wake lines
 * for the messages the server would inject.
 */
import { ArrowRightLeft, Bell, Check, Hourglass, Network, ShieldCheck, X } from "lucide-react";
import { memo, useMemo } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { useFixtureActions, useFixtureNavigation } from "./actions";
import type { FixtureState, FixtureThread, FixtureTimelineItem } from "./model";
import { displayLabel, formatClock, formatElapsed, statusVisual } from "./presentation";
import { countMembers, countsLabel, needsAttention } from "./reducer";
import { useOrchestrationFixtureStore } from "./store";
import { WorkerGlyph } from "./WorkerGlyph";

function SystemLine({
  icon,
  tone = "muted",
  at,
  children,
  className,
}: {
  readonly icon: React.ReactNode;
  readonly tone?: "muted" | "attention" | "success";
  readonly at: string;
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-1 text-xs",
        tone === "attention"
          ? "text-amber-700 dark:text-amber-300"
          : tone === "success"
            ? "text-muted-foreground"
            : "text-muted-foreground",
        className,
      )}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="shrink-0 font-mono text-[.65rem] tabular-nums text-muted-foreground/70">
        {formatClock(at)}
      </span>
    </div>
  );
}

function UserBubble({
  text,
  fromLabel,
}: {
  readonly text: string;
  readonly fromLabel: string | null;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      {fromLabel ? (
        <span className="px-1 text-[.65rem] uppercase tracking-wider text-muted-foreground">
          from {fromLabel}
        </span>
      ) : null}
      <div className="relative max-w-[80%] rounded-2xl bg-message p-3 text-message-foreground">
        <ChatMarkdown text={text} cwd={undefined} lineBreaks className="text-sm" />
      </div>
    </div>
  );
}

function AssistantBlock({ text }: { readonly text: string }) {
  return <ChatMarkdown text={text} cwd={undefined} className="text-sm leading-relaxed" />;
}

function MemberLine({
  state,
  threadId,
  replaced,
}: {
  readonly state: FixtureState;
  readonly threadId: string;
  readonly replaced: boolean;
}) {
  const navigation = useFixtureNavigation();
  const thread = state.threads[threadId];
  if (thread === undefined) return null;
  const visual = statusVisual(thread.status);
  return (
    <li>
      <button
        type="button"
        onClick={() => navigation.openThread(threadId)}
        className={cn(
          "grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-accent/50",
          replaced && "opacity-60",
        )}
      >
        <WorkerGlyph
          provider={thread.provider}
          attention={!replaced && needsAttention(thread)}
          className="size-3.5"
        />
        <span className="flex min-w-0 items-baseline gap-2">
          <span className={cn("shrink-0 font-medium", replaced && "line-through")}>
            {displayLabel(state, threadId)}
          </span>
          {replaced ? (
            <span className="shrink-0 rounded-sm border border-border/60 px-1 font-mono text-[.6rem] text-muted-foreground">
              replaced
            </span>
          ) : null}
          <span className="min-w-0 truncate text-muted-foreground">
            {thread.activity ?? visual.label}
          </span>
        </span>
        <span className={cn("shrink-0 font-mono text-[.65rem]", visual.textClass)}>
          {replaced ? "" : visual.label}
        </span>
      </button>
    </li>
  );
}

/** Card at the launch that opened an effort; later launches into it are one-line notes. */
const EffortCard = memo(function EffortCard({
  state,
  effortId,
  at,
}: {
  readonly state: FixtureState;
  readonly effortId: string;
  readonly at: string;
}) {
  const setPanelOpen = useOrchestrationFixtureStore((store) => store.setPanelOpen);
  const closeCompare = useOrchestrationFixtureStore((store) => store.closeCompare);
  const effort = state.efforts[effortId];
  const directMembers = useMemo(
    () =>
      effort === undefined
        ? []
        : effort.members.filter(
            (memberId) => state.delegations[memberId]?.parentId === effort.coordinatorId,
          ),
    [effort, state.delegations],
  );
  if (effort === undefined) return null;
  const counts = countMembers(state, effort.members);
  const nested = effort.members.length - directMembers.length;
  const closed = effort.closedAt !== null;
  const live = !closed && counts.running + counts.blocked > 0;
  const dotClass = closed
    ? "bg-muted-foreground/50"
    : counts.blocked > 0 || counts.failed > 0
      ? "bg-warning"
      : live
        ? "bg-info"
        : "bg-success";
  const elapsed = formatElapsed(effort.openedAt, effort.closedAt ?? state.now);

  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-card/50">
      <button
        type="button"
        onClick={() => {
          closeCompare();
          setPanelOpen(true);
        }}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] transition hover:bg-accent/50"
      >
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
        <Network aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">
          <span className="font-medium">{closed ? "Closed" : "Opened"}</span>{" "}
          <span className="font-medium">{effort.title}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {directMembers.map((memberId) => {
            const member = state.threads[memberId];
            if (member === undefined || state.replacements[memberId] !== undefined) return null;
            return (
              <WorkerGlyph
                key={memberId}
                provider={member.provider}
                attention={needsAttention(member)}
                className="size-3.5"
              />
            );
          })}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[.7rem] text-muted-foreground">
          <span className="hidden sm:inline">{countsLabel(counts)}</span>
          <span className="tabular-nums">{elapsed}</span>
          <span className="text-info-foreground">Open Work ▸</span>
        </span>
      </button>
      {directMembers.length > 0 ? (
        <ul className="flex flex-col border-t border-border/60 py-0.5">
          {directMembers.map((memberId) => (
            <MemberLine
              key={memberId}
              state={state}
              threadId={memberId}
              replaced={state.replacements[memberId] !== undefined}
            />
          ))}
          {nested > 0 ? (
            <li className="px-2 py-0.5 text-[.65rem] text-muted-foreground/70">
              + {nested} nested worker{nested === 1 ? "" : "s"} under{" "}
              {[
                ...new Set(
                  effort.members
                    .filter((memberId) => !directMembers.includes(memberId))
                    .map((memberId) =>
                      displayLabel(state, state.delegations[memberId]?.parentId ?? ""),
                    ),
                ),
              ].join(", ")}
            </li>
          ) : null}
        </ul>
      ) : null}
      <span className="sr-only">Opened {formatClock(at)}</span>
    </div>
  );
});

/** Ungrouped delegation: one row per launching turn. */
function LaunchRow({
  state,
  childIds,
}: {
  readonly state: FixtureState;
  readonly childIds: ReadonlyArray<string>;
}) {
  const setPanelOpen = useOrchestrationFixtureStore((store) => store.setPanelOpen);
  const counts = countMembers(state, childIds);
  const live = counts.running + counts.blocked > 0;
  const labels = childIds.map((id) => displayLabel(state, id)).join(", ");
  return (
    <button
      type="button"
      onClick={() => setPanelOpen(true)}
      className="flex w-full items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 text-left text-[13px] transition hover:bg-accent/50"
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          live ? "bg-info" : counts.failed > 0 ? "bg-destructive" : "bg-success",
        )}
      />
      <Network aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">
        <span className="font-medium">Delegated</span> {labels}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {childIds.map((id) => {
          const child = state.threads[id];
          return child === undefined ? null : (
            <WorkerGlyph
              key={id}
              provider={child.provider}
              attention={needsAttention(child)}
              className="size-3.5"
            />
          );
        })}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[.7rem] text-muted-foreground">
        <span>{countsLabel(counts)}</span>
        <span className="text-info-foreground">Open Work ▸</span>
      </span>
    </button>
  );
}

export function WaitRow({
  state,
  waitId,
}: {
  readonly state: FixtureState;
  readonly waitId: string;
}) {
  const actions = useFixtureActions();
  const wait = state.waits[waitId];
  if (wait === undefined) return null;
  const names = wait.targets.map((id) => displayLabel(state, id));
  const done = wait.targets.filter((id) => {
    const status = state.threads[id]?.status;
    return status === "completed" || status === "failed" || status === "stopped";
  }).length;
  const blocked = wait.targets.filter((id) => {
    const thread = state.threads[id];
    return thread !== undefined && needsAttention(thread);
  });

  if (wait.status === "satisfied") {
    return (
      <SystemLine
        icon={<Check className="size-3.5 text-success" />}
        tone="success"
        at={wait.resolvedAt ?? wait.openedAt}
      >
        Wait on {names.join(", ")} satisfied
        {wait.resolvedAt ? ` · after ${formatElapsed(wait.openedAt, wait.resolvedAt)}` : ""}
      </SystemLine>
    );
  }
  if (wait.status === "cancelled") {
    return (
      <SystemLine icon={<X className="size-3.5" />} at={wait.resolvedAt ?? wait.openedAt}>
        <span className="line-through">Wait on {names.join(", ")}</span> cancelled
      </SystemLine>
    );
  }
  return (
    <div
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
          · {wait.condition === "all" ? "all of" : "any of"} · {done} of {wait.targets.length} done
        </span>
        {blocked.length > 0 ? (
          <span className="text-amber-700 dark:text-amber-300">
            {" "}
            · {blocked.map((id) => displayLabel(state, id)).join(", ")} need
            {blocked.length === 1 ? "s" : ""} you
          </span>
        ) : null}
      </span>
      <Button
        size="compact"
        variant="ghost-muted"
        className="h-6 px-1.5 text-[.7rem]"
        onClick={() => actions.changeWait(wait.id, wait.condition === "all" ? "any" : "all")}
      >
        {wait.condition === "all" ? "Any of" : "All of"}
      </Button>
      <Button
        size="compact"
        variant="ghost-muted"
        className="h-6 px-1.5 text-[.7rem]"
        onClick={() => actions.cancelWait(wait.id)}
      >
        Cancel wait
      </Button>
    </div>
  );
}

function ApprovalRow({
  item,
  thread,
}: {
  readonly item: Extract<FixtureTimelineItem, { kind: "approval" }>;
  readonly thread: FixtureThread;
}) {
  const actions = useFixtureActions();
  const pending = item.resolution === "pending";
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        pending ? "border-warning/40 bg-warning-surface/40" : "border-border/60 bg-card/30",
      )}
    >
      <div className="flex items-center gap-2">
        <ShieldCheck
          aria-hidden
          className={cn(
            "size-4 shrink-0",
            pending ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground",
          )}
        />
        <span className="font-medium">
          {pending ? "Approval requested" : item.resolution === "approved" ? "Approved" : "Denied"}
        </span>
        <span className="ml-auto font-mono text-[.65rem] text-muted-foreground/70">
          {formatClock(item.at)}
        </span>
      </div>
      <div className="mt-1.5">
        <ChatMarkdown text={item.text} cwd={undefined} className="text-sm" />
      </div>
      {pending ? (
        <div className="mt-2 flex gap-2">
          <Button size="compact" onClick={() => actions.resolveApproval(thread.id, true)}>
            Approve
          </Button>
          <Button
            size="compact"
            variant="outline"
            onClick={() => actions.resolveApproval(thread.id, false)}
          >
            Deny
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export const TranscriptItem = memo(function TranscriptItem({
  state,
  thread,
  item,
}: {
  readonly state: FixtureState;
  readonly thread: FixtureThread;
  readonly item: FixtureTimelineItem;
}) {
  switch (item.kind) {
    case "message":
      return item.role === "user" ? (
        <UserBubble
          text={item.text}
          fromLabel={item.fromId === undefined ? null : displayLabel(state, item.fromId)}
        />
      ) : (
        <AssistantBlock text={item.text} />
      );
    case "effort":
      return <EffortCard state={state} effortId={item.effortId} at={item.at} />;
    case "launch":
      return <LaunchRow state={state} childIds={item.childIds} />;
    case "wait":
      return <WaitRow state={state} waitId={item.waitId} />;
    case "wake":
      return (
        <SystemLine
          icon={<Bell className="size-3.5" />}
          tone={item.tone === "attention" ? "attention" : "muted"}
          at={item.at}
        >
          {item.text}
        </SystemLine>
      );
    case "note":
      return (
        <SystemLine icon={<ArrowRightLeft className="size-3.5" />} at={item.at}>
          {item.text}
        </SystemLine>
      );
    case "approval":
      return <ApprovalRow item={item} thread={thread} />;
  }
});

/** Under the header of a delegated thread: where it belongs and who sent it. */
export function LineageBanner({
  state,
  threadId,
}: {
  readonly state: FixtureState;
  readonly threadId: string;
}) {
  const navigation = useFixtureNavigation();
  const delegation = state.delegations[threadId];
  const thread = state.threads[threadId];
  if (delegation === undefined || thread === undefined) return null;
  const effort = thread.effortId === null ? undefined : state.efforts[thread.effortId];
  const replaces = Object.entries(state.replacements).find(
    ([, successor]) => successor === threadId,
  )?.[0];
  const replacedBy = state.replacements[threadId];
  const parentTitle = state.threads[delegation.parentId]?.title ?? delegation.parentId;
  const link = (label: string, target: string) => (
    <button
      type="button"
      onClick={() => navigation.openThread(target)}
      className="font-medium text-foreground/90 hover:underline"
    >
      {label}
    </button>
  );
  return (
    <div className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
      <Network aria-hidden className="size-3.5 shrink-0" />
      {effort ? (
        <>
          <span>Part of</span>
          {link(effort.title, delegation.parentId)}
          {effort.closedAt !== null ? <span>(closed)</span> : null}
          <span>·</span>
        </>
      ) : null}
      <span>delegated by</span>
      {link(parentTitle, delegation.parentId)}
      {replaces !== undefined ? (
        <>
          <span>·</span>
          <span>replaces</span>
          {link(displayLabel(state, replaces), replaces)}
        </>
      ) : null}
      {replacedBy !== undefined ? (
        <>
          <span>·</span>
          <span className="text-amber-700 dark:text-amber-300">replaced by</span>
          {link(displayLabel(state, replacedBy), replacedBy)}
        </>
      ) : null}
    </div>
  );
}
