import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { DurableComposerEntry } from "./durableCommandOutbox";
import { deliverDurableComposerCommand } from "./durableCommandOutboxDelivery";
import { threadEnvironment } from "./state/threads";

const environmentId = EnvironmentId.make("environment-1");

const state = vi.hoisted(() => ({
  sent: [] as Array<{
    readonly command: unknown;
    readonly environmentId: unknown;
    readonly input: unknown;
  }>,
  thread: null as null | { readonly runtimeMode: string; readonly interactionMode: string },
  capabilities: {} as Record<string, unknown>,
  placed: null as null | { readonly environmentId: string; readonly threadId: string },
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: async (
    _registry: unknown,
    command: unknown,
    request: { environmentId: unknown; input: unknown },
  ) => {
    state.sent.push({ command, environmentId: request.environmentId, input: request.input });
    return AsyncResult.success({ sequence: 1 });
  },
}));
vi.mock("./state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/entities")>()),
  readThreadShell: () => state.thread,
}));
vi.mock("./composerDraftStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./composerDraftStore")>()),
  placedDraftThreadRef: () => state.placed,
}));
vi.mock("./state/server", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await importOriginal<typeof import("./state/server")>()),
    environmentServerConfigsAtom: Atom.make(
      new Map([
        ["environment-1", { environment: { capabilities: state.capabilities } }],
        ["environment-2", { environment: { capabilities: state.capabilities } }],
      ]),
    ),
  };
});
vi.mock("./state/attachments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./state/attachments")>();
  return {
    ...actual,
    attachmentEnvironment: {
      ...actual.attachmentEnvironment,
      createUploadUrl: {
        run: () => Effect.succeed({ attachmentId: "uploaded-1", relativeUrl: "/upload/1" }),
      } as never,
    },
  };
});
vi.mock("./state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/session")>()),
  readPreparedConnection: () => ({ httpBaseUrl: "http://environment.test" }) as never,
}));

function setup(
  thread: { readonly runtimeMode: string; readonly interactionMode: string },
  placed: { readonly environmentId: string; readonly threadId: string } | null = null,
) {
  state.sent = [];
  state.thread = thread;
  for (const key of Object.keys(state.capabilities)) delete state.capabilities[key];
  state.placed = placed;
}

describe("deliverDurableComposerCommand", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers a triage reply with the thread's settings as they are when it arrives", async () => {
    // Another client switched the thread to plan mode with full access after the reply was queued.
    setup({ runtimeMode: "full-access", interactionMode: "plan" });
    const entry: DurableComposerEntry = {
      id: 1,
      enqueuedAt: 0,
      state: { _tag: "Pending" },
      command: {
        environmentId,
        threadId: ThreadId.make("thread-1"),
        commandId: CommandId.make("command-1"),
        messageId: MessageId.make("message-1"),
        createdAt: "2026-11-20T10:00:00.000Z",
        text: "Go ahead",
        attachments: [],
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        dispatchMode: "queue",
        titleSeed: "Go ahead",
        inheritThreadSettings: true,
      },
    };

    await deliverDurableComposerCommand(entry, async () => {});

    expect(state.sent.map(({ command }) => command)).toEqual([threadEnvironment.startTurn]);
    expect(state.sent[0]?.input).not.toHaveProperty("modelSelection");
  });

  it.each([
    [403, "permanent"],
    [503, "transient"],
  ] as const)(
    "classifies an upload the environment refused with %i as %s",
    async (status, classification) => {
      setup({ runtimeMode: "approval-required", interactionMode: "default" });
      state.capabilities.attachmentUploads = true;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status })),
      );
      const entry: DurableComposerEntry = {
        id: 1,
        enqueuedAt: 0,
        state: { _tag: "Pending" },
        command: {
          environmentId,
          threadId: ThreadId.make("thread-1"),
          commandId: CommandId.make("command-1"),
          messageId: MessageId.make("message-1"),
          createdAt: "2026-11-20T10:00:00.000Z",
          text: "Look",
          attachments: [
            {
              attachment: {
                type: "image",
                id: "image-1",
                name: "shot.png",
                mimeType: "image/png",
                sizeBytes: 3,
              },
              blob: new Blob(["png"], { type: "image/png" }),
            },
          ],
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          dispatchMode: "queue",
          titleSeed: "Look",
        },
      };

      await expect(deliverDurableComposerCommand(entry, async () => {})).rejects.toMatchObject({
        classification,
        message: `'shot.png' could not upload: The environment refused the upload (${status}).`,
      });
      expect(state.sent.map(({ command }) => command)).not.toContain(threadEnvironment.startTurn);
    },
  );

  it("sends a follow-up to the thread an Auto launch started on another machine", async () => {
    // The user sent again while the first message's Auto launch was still deciding.
    setup(
      { runtimeMode: "full-access", interactionMode: "default" },
      { environmentId: "environment-2", threadId: "thread-placed" },
    );
    const recorded: Array<unknown> = [];
    await deliverDurableComposerCommand(
      {
        id: 2,
        enqueuedAt: 0,
        state: { _tag: "Pending" },
        command: {
          environmentId,
          threadId: ThreadId.make("thread-draft"),
          commandId: CommandId.make("command-2"),
          messageId: MessageId.make("message-2"),
          createdAt: "2026-11-20T10:00:00.000Z",
          text: "And the tests too",
          attachments: [],
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          dispatchMode: "queue",
          titleSeed: "And the tests too",
        },
      },
      async (command) => {
        recorded.push(command);
      },
    );

    expect(state.sent[0]?.environmentId).toBe("environment-2");
    expect(state.sent[0]?.input).toMatchObject({ threadId: "thread-placed" });
    expect(recorded[0]).toMatchObject({
      environmentId: "environment-2",
      threadId: "thread-placed",
    });
  });

  it("refuses a follow-up whose attachment exists only as an upload to the machine it left", async () => {
    setup(
      { runtimeMode: "full-access", interactionMode: "default" },
      { environmentId: "environment-2", threadId: "thread-placed" },
    );
    const recorded: Array<unknown> = [];
    const delivered = deliverDurableComposerCommand(
      {
        id: 3,
        enqueuedAt: 0,
        state: { _tag: "Pending" },
        command: {
          environmentId,
          threadId: ThreadId.make("thread-draft"),
          commandId: CommandId.make("command-3"),
          messageId: MessageId.make("message-3"),
          createdAt: "2026-11-20T10:00:00.000Z",
          text: "See the spec",
          attachments: [
            {
              attachment: {
                type: "file",
                id: "attachment-1" as never,
                name: "spec.pdf",
                mimeType: "application/pdf",
                sizeBytes: 10,
              },
              blob: null,
              uploadedAttachmentId: "upload-on-environment-1",
            },
          ],
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          dispatchMode: "queue",
          titleSeed: "See the spec",
        },
      },
      async (command) => {
        recorded.push(command);
      },
    );

    await expect(delivered).rejects.toMatchObject({
      classification: "permanent",
      message: expect.stringContaining("never uploaded"),
    });
    expect(state.sent).toEqual([]);
    // Opening or editing the rejected message lands on the placed thread, without the old upload.
    expect(recorded[0]).toMatchObject({
      environmentId: "environment-2",
      threadId: "thread-placed",
    });
    expect(recorded[0]).not.toHaveProperty(["attachments", 0, "uploadedAttachmentId"]);
  });
});
