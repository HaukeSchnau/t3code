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
  sent: [] as Array<{ readonly command: unknown; readonly input: unknown }>,
  thread: null as null | { readonly runtimeMode: string; readonly interactionMode: string },
  capabilities: {} as Record<string, unknown>,
}));

vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: async (_registry: unknown, command: unknown, request: { input: unknown }) => {
    state.sent.push({ command, input: request.input });
    return AsyncResult.success({ sequence: 1 });
  },
}));
vi.mock("./state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state/entities")>()),
  readThreadShell: () => state.thread,
}));
vi.mock("./state/server", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await importOriginal<typeof import("./state/server")>()),
    environmentServerConfigsAtom: Atom.make(
      new Map([["environment-1", { environment: { capabilities: state.capabilities } }]]),
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

function setup(thread: { readonly runtimeMode: string; readonly interactionMode: string }) {
  state.sent = [];
  state.thread = thread;
  for (const key of Object.keys(state.capabilities)) delete state.capabilities[key];
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
});
