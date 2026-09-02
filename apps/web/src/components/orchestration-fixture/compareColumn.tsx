/**
 * Feeds the production Compare surface from scenario artifacts, so the fixture
 * exercises the same component the real app renders.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { WorkerState } from "@t3tools/client-runtime/state/threads";
import type { OrchestrationCheckpointFile, ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import type { CompareColumnData } from "../work/compareData";
import type { FixtureThreadStatus } from "./model";
import { displayLabel } from "./presentation";
import { PreviewFrame } from "./PreviewFrame";
import { latestAnswer } from "./reducer";
import { useFixtureState } from "./store";

function workerStateOf(status: FixtureThreadStatus): WorkerState {
  switch (status) {
    case "queued":
    case "running":
      return "working";
    case "blocked-approval":
    case "blocked-input":
      return "blocked";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
}

const EMPTY_FILES: ReadonlyArray<OrchestrationCheckpointFile> = [];

export function useFixtureCompareColumn(ref: ScopedThreadRef): CompareColumnData {
  const state = useFixtureState();
  const thread = state.threads[ref.threadId];
  const preview = thread?.artifacts.preview;
  const title = thread?.title ?? ref.threadId;
  return useMemo<CompareColumnData>(
    () => ({
      key: scopedThreadKey(ref),
      ref,
      title,
      label: state.delegations[ref.threadId]?.label ?? displayLabel(state, ref.threadId),
      state: thread === undefined ? null : workerStateOf(thread.status),
      answer: thread === undefined ? null : latestAnswer(thread),
      diff: {
        available: thread?.artifacts.patch !== undefined,
        pending: false,
        patch: thread?.artifacts.patch ?? null,
        error: null,
      },
      files:
        thread?.artifacts.files?.map((file) => ({
          path: file.path,
          kind: file.kind,
          additions: file.additions,
          deletions: file.deletions,
        })) ?? EMPTY_FILES,
      renderPreview:
        preview === undefined
          ? null
          : () => (
              <PreviewFrame
                variant={preview.variant}
                url={preview.url}
                title={`${title} preview`}
              />
            ),
      terminalAvailable: thread?.artifacts.terminal !== undefined,
    }),
    [ref, state, thread, preview, title],
  );
}
