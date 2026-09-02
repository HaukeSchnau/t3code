/**
 * Data feeding one Compare column.
 *
 * Compare composes real per-thread surfaces, so the column data comes from
 * the same atoms those surfaces read: thread detail for the answer and
 * changed files, the checkpoint diff query for the patch, preview sessions
 * for the frame. The hook is exposed through a context so the dev fixture can
 * substitute its scenario data without a second Compare implementation.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { resolveWorkerState, type WorkerState } from "@t3tools/client-runtime/state/threads";
import type { OrchestrationCheckpointFile, ScopedThreadRef } from "@t3tools/contracts";
import { createContext, use, useMemo, type ReactNode } from "react";

import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { isPreviewSupportedInRuntime, useThreadPreviewState } from "../../previewStateStore";
import { useThreadLineage } from "../../state/coordination";
import { useThread, useThreadShell } from "../../state/entities";
import { useThreadRunningTerminalIds } from "../../state/terminalSessions";
import { PreviewPanel } from "../preview/PreviewPanel";

export interface CompareColumnData {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  readonly title: string;
  /** The coordinator's label for this worker, when it has one. */
  readonly label: string | null;
  readonly state: WorkerState | null;
  readonly answer: string | null;
  readonly diff: {
    readonly available: boolean;
    readonly pending: boolean;
    readonly patch: string | null;
    readonly error: string | null;
  };
  readonly files: ReadonlyArray<OrchestrationCheckpointFile>;
  /** Present when a live preview can be embedded for this thread. */
  readonly renderPreview: (() => ReactNode) | null;
  readonly terminalAvailable: boolean;
}

export type CompareColumnHook = (ref: ScopedThreadRef) => CompareColumnData;

const EMPTY_FILES: ReadonlyArray<OrchestrationCheckpointFile> = [];

/** Merges every checkpoint's files into one list, summing counts per path. */
export function mergeCheckpointFiles(
  checkpoints: ReadonlyArray<{ readonly files: ReadonlyArray<OrchestrationCheckpointFile> }>,
): ReadonlyArray<OrchestrationCheckpointFile> {
  if (checkpoints.length === 0) return EMPTY_FILES;
  const byPath = new Map<string, OrchestrationCheckpointFile>();
  for (const checkpoint of checkpoints) {
    for (const file of checkpoint.files) {
      const existing = byPath.get(file.path);
      byPath.set(
        file.path,
        existing === undefined
          ? file
          : {
              ...existing,
              kind: file.kind,
              additions: existing.additions + file.additions,
              deletions: existing.deletions + file.deletions,
            },
      );
    }
  }
  return [...byPath.values()];
}

export function useProductionCompareColumn(ref: ScopedThreadRef): CompareColumnData {
  const key = scopedThreadKey(ref);
  const shell = useThreadShell(ref);
  const thread = useThread(ref);
  const lineage = useThreadLineage();
  const preview = useThreadPreviewState(ref);
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  });
  const checkpoints = thread?.checkpoints ?? [];
  const toTurnCount = checkpoints.reduce(
    (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
    0,
  );
  const diff = useCheckpointDiff(
    {
      environmentId: ref.environmentId,
      threadId: ref.threadId,
      fromTurnCount: 0,
      toTurnCount,
      ignoreWhitespace: false,
      cacheScope: "work-compare",
    },
    { enabled: toTurnCount > 0 },
  );
  const files = useMemo(() => mergeCheckpointFiles(checkpoints), [checkpoints]);
  const answer = useMemo(() => {
    const messages = thread?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant" && !message.streaming && message.text.trim().length > 0) {
        return message.text;
      }
    }
    return null;
  }, [thread?.messages]);
  const previewAvailable =
    isPreviewSupportedInRuntime() && Object.keys(preview.sessions).length > 0;

  return {
    key,
    ref,
    title: shell?.title ?? thread?.title ?? ref.threadId,
    label: lineage.entries.get(key)?.label ?? null,
    state: shell === null ? null : resolveWorkerState(shell),
    answer,
    diff: {
      available: toTurnCount > 0,
      pending: toTurnCount > 0 && diff.isPending,
      patch: diff.data?.diff ?? null,
      error: diff.error,
    },
    files,
    renderPreview: previewAvailable
      ? () => <PreviewPanel mode="embedded" threadRef={ref} visible />
      : null,
    terminalAvailable: runningTerminalIds.length > 0,
  };
}

export const CompareColumnDataContext = createContext<CompareColumnHook>(
  useProductionCompareColumn,
);

export function useCompareColumnHook(): CompareColumnHook {
  return use(CompareColumnDataContext);
}
