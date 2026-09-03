import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { MessageId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import { appAtomRegistry } from "./atom-registry";
import {
  composerDraftsAtom,
  decodePersistedComposerDrafts,
  persistedQueuedEditIdsAtom,
} from "./use-composer-drafts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

vi.hoisted(() => {
  process.env.NODE_ENV = "development";
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DRAFT_KEY = "environment-train:thread-train";
const MESSAGE_ID = MessageId.make("message-being-edited");
let mountedEditingIds: Readonly<Record<MessageId, true>> = {};
const originalDrafts = appAtomRegistry.get(composerDraftsAtom);

function EditingHoldProbe() {
  mountedEditingIds = useAtomValue(persistedQueuedEditIdsAtom);
  return null;
}

afterEach(() => {
  appAtomRegistry.set(composerDraftsAtom, originalDrafts);
  mountedEditingIds = {};
});

describe("queued message edit lifecycle", () => {
  it("persists the edit identity beside copied content", () => {
    const decoded = decodePersistedComposerDrafts({
      schemaVersion: 1,
      drafts: {
        [DRAFT_KEY]: {
          text: "edited on the train",
          attachments: [],
          editingQueuedMessageId: MESSAGE_ID,
        },
      },
    });
    expect(decoded[DRAFT_KEY]).toMatchObject({
      text: "edited on the train",
      editingQueuedMessageId: MESSAGE_ID,
    });
  });

  it("keeps the original delivery held across route unmount until copied draft is cleared", () => {
    appAtomRegistry.set(composerDraftsAtom, {
      ...originalDrafts,
      [DRAFT_KEY]: {
        text: "edited on the train",
        attachments: [],
        editingQueuedMessageId: MESSAGE_ID,
      },
    });

    let renderer: ReactTestRenderer;
    act(
      () =>
        void (renderer = create(
          <RegistryContext.Provider value={appAtomRegistry}>
            <EditingHoldProbe />
          </RegistryContext.Provider>,
        )),
    );
    expect(mountedEditingIds[MESSAGE_ID]).toBe(true);
    act(() => renderer.unmount());

    // Navigation unmounts presentation only. The route-independent draft atom
    // still blocks the original outbox intent, so it cannot deliver while a
    // stale copied draft could later create a duplicate.
    expect(appAtomRegistry.get(persistedQueuedEditIdsAtom)[MESSAGE_ID]).toBe(true);
    expect(appAtomRegistry.get(composerDraftsAtom)[DRAFT_KEY]?.text).toBe("edited on the train");

    // Cancel clears copied content and edit identity in the same atom update;
    // only then does the original become eligible again.
    const current = appAtomRegistry.get(composerDraftsAtom);
    const cleared = { ...current };
    delete cleared[DRAFT_KEY];
    appAtomRegistry.set(composerDraftsAtom, cleared);
    expect(appAtomRegistry.get(persistedQueuedEditIdsAtom)[MESSAGE_ID]).toBeUndefined();
    expect(appAtomRegistry.get(composerDraftsAtom)[DRAFT_KEY]).toBeUndefined();
  });
});
