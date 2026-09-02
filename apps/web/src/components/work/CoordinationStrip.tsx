/**
 * One quiet line under the thread header, shown only when the thread takes
 * part in coordination. Children learn where they belong; coordinators get
 * the roll-up and a way into Work. Colour appears only for attention.
 */
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  coordinationCountsLabel,
  countWorkers,
  descendantKeys,
  openWaitsOf,
  resolveWorkerState,
} from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Network } from "lucide-react";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { useThreadLineage } from "../../state/coordination";
import { useThreadShells } from "../../state/entities";
import { Button } from "../ui/button";

function ThreadLink({ threadKey, title }: { readonly threadKey: string; readonly title: string }) {
  const navigate = useNavigate();
  const ref = parseScopedThreadKey(threadKey);
  if (ref === null) return <span className="font-medium text-foreground/90">{title}</span>;
  return (
    <button
      type="button"
      className="font-medium text-foreground/90 hover:underline"
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: ref.environmentId, threadId: ref.threadId },
        })
      }
    >
      {title}
    </button>
  );
}

export function CoordinationStrip({
  threadRef,
  onOpenWork,
  className,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onOpenWork: () => void;
  readonly className?: string;
}) {
  const lineage = useThreadLineage();
  const threads = useThreadShells();
  const key = scopedThreadKey(threadRef);
  const entry = lineage.entries.get(key);
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
  const titleOf = (threadKey: string) =>
    shellsByKey.get(threadKey)?.title ?? lineage.entries.get(threadKey)?.label ?? "a thread";

  const childKeys = entry?.childKeys ?? [];
  const efforts = lineage.effortsByCoordinatorKey.get(key) ?? [];
  const waits = openWaitsOf(lineage, key);
  const coordinates = childKeys.length > 0 || efforts.length > 0 || waits.length > 0;
  const parentKey = entry?.parentKey ?? null;
  if (!coordinates && parentKey === null) return null;

  const counts = countWorkers(lineage, descendantKeys(lineage, key), (childKey) => {
    const shell = shellsByKey.get(childKey);
    return shell === undefined ? null : resolveWorkerState(shell);
  });
  const countsLabel = coordinationCountsLabel(counts);
  const waitingOn = waits.reduce((sum, wait) => sum + wait.memberKeys.length, 0);
  const effort =
    entry?.effortId === null || entry?.effortId === undefined
      ? undefined
      : lineage.efforts.find((candidate) => candidate.effortId === entry.effortId);

  return (
    <div
      data-testid="coordination-strip"
      className={cn(
        "flex h-8 min-w-0 items-center gap-1.5 border-b border-border/60 px-4 text-xs text-muted-foreground sm:px-5",
        className,
      )}
    >
      <Network aria-hidden className="size-3.5 shrink-0" />
      {parentKey !== null ? (
        <span className="flex min-w-0 items-center gap-1 truncate">
          {effort ? (
            <>
              <span>Part of</span>
              <ThreadLink threadKey={parentKey} title={effort.title} />
              {effort.closedAt !== null ? <span>(closed)</span> : null}
              <span>·</span>
            </>
          ) : null}
          <span>delegated by</span>
          <ThreadLink threadKey={parentKey} title={titleOf(parentKey)} />
          {entry?.replacesKey ? (
            <>
              <span>·</span>
              <span>replaces</span>
              <ThreadLink threadKey={entry.replacesKey} title={titleOf(entry.replacesKey)} />
            </>
          ) : null}
          {entry?.replacedByKey ? (
            <>
              <span>·</span>
              <span className="text-amber-700 dark:text-amber-300">replaced by</span>
              <ThreadLink threadKey={entry.replacedByKey} title={titleOf(entry.replacedByKey)} />
            </>
          ) : null}
        </span>
      ) : null}
      {coordinates ? (
        <span className="flex min-w-0 items-center gap-1 truncate">
          {parentKey !== null ? <span>·</span> : null}
          <span className={cn(counts.blocked > 0 && "text-amber-700 dark:text-amber-300")}>
            {countsLabel ?? `${efforts.length} effort${efforts.length === 1 ? "" : "s"}`}
          </span>
          {waitingOn > 0 ? <span>· waiting on {waitingOn}</span> : null}
        </span>
      ) : null}
      <Button
        size="compact"
        variant="ghost-muted"
        className="ml-auto h-6 shrink-0 px-1.5 text-[.7rem]"
        onClick={onOpenWork}
      >
        Work
      </Button>
    </div>
  );
}
