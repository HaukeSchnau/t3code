import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { MessageId, type OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import {
  codexOverloadRetry,
  codexOverloadRetryNotice,
  codexResumableRunId,
  isCodexRunActive,
} from "@t3tools/shared/codexTurnContinuation";
import { useCallback, useMemo, useRef } from "react";

import { uuidv4 } from "../../lib/uuid";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Pause and message-free Resume for Codex threads. Other providers keep Stop
 * and get neither control. Values are primitives so memoized hosts can skip
 * renders while the projection streams.
 */
export function useCodexTurnContinuation(
  thread: EnvironmentThreadShell | null,
  projection: OrchestrationV2ThreadProjection | null,
) {
  const startTurn = useAtomCommand(threadEnvironment.startTurn, "resume thread");
  const canPause = useMemo(() => projection !== null && isCodexRunActive(projection), [projection]);
  const resumableRunId = useMemo(
    () => (projection === null ? null : codexResumableRunId(projection)),
    [projection],
  );
  const retryNotice = useMemo(
    () => (projection === null ? null : codexOverloadRetryNotice(codexOverloadRetry(projection))),
    [projection],
  );
  const environmentId = thread?.environmentId ?? null;
  const threadId = thread?.id ?? null;
  const runtimeMode = thread?.runtimeMode ?? null;
  const interactionMode = thread?.interactionMode ?? null;
  const resumingRef = useRef(false);
  const resume = useCallback(() => {
    if (
      resumingRef.current ||
      environmentId === null ||
      threadId === null ||
      runtimeMode === null ||
      interactionMode === null ||
      resumableRunId === null
    )
      return;
    resumingRef.current = true;
    void startTurn({
      environmentId,
      input: {
        threadId,
        creationSource: "mobile",
        manualContinuationOfRunId: resumableRunId,
        message: { messageId: MessageId.make(uuidv4()), role: "user", text: "", attachments: [] },
        runtimeMode,
        interactionMode,
        dispatchMode: "start",
      },
    }).finally(() => {
      resumingRef.current = false;
    });
  }, [environmentId, interactionMode, resumableRunId, runtimeMode, startTurn, threadId]);
  return useMemo(
    () => ({ canPause, resume: resumableRunId === null ? null : resume, retryNotice }),
    [canPause, resumableRunId, resume, retryNotice],
  );
}
