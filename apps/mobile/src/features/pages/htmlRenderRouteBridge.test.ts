import {
  NEEDS_YOU_SEND_BUSY,
  needsYouDeckKey,
} from "@t3tools/client-runtime/state/needs-you-triage";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const outbox = vi.hoisted(() => ({
  manager: null as unknown as ReturnType<
    typeof import("../../state/thread-outbox-manager").createThreadOutboxManager
  >,
}));

vi.mock("../../state/thread-outbox", async () => {
  const { createThreadOutboxManager } = await import("../../state/thread-outbox-manager");
  const { appAtomRegistry } = await import("../../state/atom-registry");
  outbox.manager = createThreadOutboxManager({
    registry: appAtomRegistry,
    storage: {
      load: async () => ({ messages: [], errors: [] }),
      write: async () => undefined,
      remove: async () => undefined,
    },
  });
  return {
    threadOutboxManager: outbox.manager,
    enqueueThreadOutboxMessage: (
      message: Parameters<typeof outbox.manager.enqueue>[0],
    ): Promise<void> => outbox.manager.enqueue(message),
  };
});

import { appAtomRegistry } from "../../state/atom-registry";
import { queueTriageMessage, triageDrafts } from "../needs-you/triageSession";
import { htmlRenderRouteBridge } from "./htmlRenderRouteBridge";

describe("htmlRenderRouteBridge", () => {
  it("holds a page expanded from a triage card behind the card's queued reply", async () => {
    const thread = {
      environmentId: EnvironmentId.make("environment-1"),
      threadId: ThreadId.make("thread-1"),
    };
    const key = needsYouDeckKey({ environmentId: thread.environmentId, id: thread.threadId });
    await triageDrafts.send(key, () => queueTriageMessage(thread, "Ship it"));

    const bridge = htmlRenderRouteBridge({
      environmentId: "environment-1",
      threadId: "thread-1",
      renderId: "page-1",
      triage: "1",
    });
    await expect(
      bridge?.send?.({ text: "Approve", context: { version: 1, records: [] } }),
    ).rejects.toThrow(NEEDS_YOU_SEND_BUSY);
    expect(
      Object.values(appAtomRegistry.get(outbox.manager.queuedMessagesByThreadKeyAtom))
        .flat()
        .map((message) => message.text),
    ).toEqual(["Ship it"]);
  });
});
