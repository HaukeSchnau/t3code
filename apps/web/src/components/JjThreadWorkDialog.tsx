import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { formatJjTurns } from "@t3tools/client-runtime/state/vcs";
import type { EnvironmentId, JjThreadWorkRepository, ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment } from "~/state/vcs";
import { Badge } from "./ui/badge";
import {
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Spinner } from "./ui/spinner";

const describeFailure = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Could not search the repositories.";

type WorkState =
  | { readonly kind: "loading" }
  | { readonly kind: "loaded"; readonly repositories: ReadonlyArray<JjThreadWorkRepository> }
  | { readonly kind: "failed"; readonly message: string };

/** Lists the thread's jj changes in every repository the server knows. */
export function JjThreadWorkDialogPopup(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const findWork = useAtomCommand(vcsEnvironment.jjThreadWork, { reportFailure: false });
  const [state, setState] = useState<WorkState>({ kind: "loading" });
  const { environmentId, threadId } = props;

  useEffect(() => {
    let cancelled = false;
    void findWork({ environmentId, input: { threadId } }).then((result) => {
      if (cancelled || (result._tag === "Failure" && isAtomCommandInterrupted(result))) return;
      setState(
        result._tag === "Failure"
          ? { kind: "failed", message: describeFailure(squashAtomCommandFailure(result)) }
          : { kind: "loaded", repositories: result.value.repositories },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, findWork, threadId]);

  return (
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>This thread's jj work</DialogTitle>
        <DialogDescription>
          Changes with this thread's trailer, in every repository on this environment.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {state.kind === "loading" ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" tone="muted" /> Searching repositories…
          </div>
        ) : state.kind === "failed" ? (
          <p className="text-sm text-destructive">{state.message}</p>
        ) : state.repositories.length === 0 ? (
          <p className="text-sm text-muted-foreground">No jj changes from this thread yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {state.repositories.map((repository) => (
              <li key={repository.root} className="flex flex-col gap-1">
                <code className="truncate text-xs text-muted-foreground">{repository.root}</code>
                {repository.changes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No changes yet; the agent ran {repository.taggedOperations} jj operations here.
                  </p>
                ) : (
                  <ul className="flex flex-col">
                    {repository.changes.map((change) => (
                      <li key={change.changeId} className="flex items-center gap-2 py-0.5">
                        <code className="shrink-0 text-xs text-muted-foreground">
                          {change.changeId.slice(0, 8)}
                        </code>
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {change.description || "(no description)"}
                        </span>
                        {formatJjTurns(change.turns) ? (
                          <Badge variant="secondary" size="sm">
                            {formatJjTurns(change.turns)}
                          </Badge>
                        ) : null}
                        {change.pushed ? (
                          <Badge variant="outline" size="sm">
                            pushed
                          </Badge>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogPanel>
    </DialogPopup>
  );
}
