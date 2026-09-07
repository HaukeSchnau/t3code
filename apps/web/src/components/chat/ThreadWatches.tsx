import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { openWatchesOf } from "@t3tools/client-runtime/state/threads";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useThreadLineage } from "../../state/coordination";

/** Watch state comes from the shell; showing it never subscribes to thread detail. */
export function ThreadWatches({ threadRef }: { readonly threadRef: ScopedThreadRef | null }) {
  const lineage = useThreadLineage();
  const watches = threadRef === null ? [] : openWatchesOf(lineage, scopedThreadKey(threadRef));
  if (watches.length === 0) return null;

  return (
    <details className="shrink-0 border-b border-border px-4 py-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        {watches.length} active {watches.length === 1 ? "watch" : "watches"}
      </summary>
      <ul className="mt-2 space-y-2">
        {watches.map((watch) => {
          const source =
            watch.source.type === "process"
              ? watch.source.argv.join(" ")
              : watch.source.type === "shell"
                ? watch.source.command
                : watch.source.url;
          return (
            <li key={watch.watchId} className="break-words">
              <div>{watch.lastSummary ?? source}</div>
              {watch.lastSummary === null ? null : (
                <div className="text-muted-foreground">{source}</div>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
