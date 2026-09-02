/**
 * Production human corrections for the Work panel.
 *
 * Only Stop is wired: it is the ordinary thread-turn interrupt command sent
 * over the environment's authenticated connection, the same path the chat
 * header uses. Effort, wait and retry verbs exist on the orchestration HTTP
 * API, but their payloads carry an agent actor scope (provider session and
 * instance identity) that a person in the web client does not have, so they
 * stay absent here rather than being sent under a fabricated identity.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadTurnInterruptInput } from "../ChatView.logic";
import type { WorkActions } from "./WorkPanel";

export function useProductionWorkActions(): WorkActions {
  const threads = useThreadShells();
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn, "Stop worker");
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
  return useMemo<WorkActions>(
    () => ({
      stopThread: (ref: ScopedThreadRef) => {
        const shell = shellsByKey.get(scopedThreadKey(ref));
        // A thread whose shell is not loaded belongs to an environment this
        // client is not connected to; there is nothing to interrupt from here.
        if (shell === undefined) return;
        void interruptTurn({
          environmentId: ref.environmentId,
          input: buildThreadTurnInterruptInput(shell),
        });
      },
    }),
    [interruptTurn, shellsByKey],
  );
}
