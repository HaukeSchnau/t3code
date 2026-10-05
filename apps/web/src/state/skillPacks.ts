import type { EnvironmentId, SkillPackId, ThreadId } from "@t3tools/contracts";
import { createSkillPackEnvironmentAtoms } from "@t3tools/client-runtime/state/skill-packs";
import { create } from "zustand";

import { connectionAtomRuntime } from "../connection/runtime";

/** Fork: skill packs (patches/skill-packs.md). */
export const skillPackEnvironment = createSkillPackEnvironmentAtoms(connectionAtomRuntime);

const draftKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `${environmentId}:${threadId}`;

/**
 * Packs picked in a draft before its first turn creates the thread. A draft
 * without an entry follows the project default.
 */
export const useDraftSkillPacksStore = create<{
  readonly packIdsByDraft: Readonly<Record<string, ReadonlyArray<SkillPackId>>>;
  readonly set: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    packIds: ReadonlyArray<SkillPackId> | null,
  ) => void;
}>()((set) => ({
  packIdsByDraft: {},
  set: (environmentId, threadId, packIds) =>
    set((state) => {
      const { [draftKey(environmentId, threadId)]: _previous, ...rest } = state.packIdsByDraft;
      return {
        packIdsByDraft:
          packIds === null ? rest : { ...rest, [draftKey(environmentId, threadId)]: packIds },
      };
    }),
}));

export function readDraftSkillPackIds(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<SkillPackId> | undefined {
  return useDraftSkillPacksStore.getState().packIdsByDraft[draftKey(environmentId, threadId)];
}

export function useDraftSkillPackIds(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ReadonlyArray<SkillPackId> | undefined {
  return useDraftSkillPacksStore(
    (state) => state.packIdsByDraft[draftKey(environmentId, threadId)],
  );
}
