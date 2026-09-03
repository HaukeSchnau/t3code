import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { vi } from "vitest";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { composerDraftsAtom, composerDraftsReadyAtom } from "./use-composer-drafts";
import { useThreadOutboxDrain } from "./use-thread-outbox-drain";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
  var __THREAD_OUTBOX_DRAIN_TEST_ATOMS__:
    | {
        queuedMessagesByThreadKeyAtom: ReturnType<
          typeof Atom.make<Record<string, ReadonlyArray<QueuedThreadMessage>>>
        >;
        deliveryStatesAtom: ReturnType<
          typeof Atom.make<Readonly<Record<string, { readonly _tag: "Pending" }>>>
        >;
        threadShellsAtom: ReturnType<typeof Atom.make<ReadonlyArray<EnvironmentThreadShell>>>;
      }
    | undefined;
}

vi.hoisted(() => {
  process.env.NODE_ENV = "development";
});

const mocks = vi.hoisted(() => ({
  startTurn: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-train");
const THREAD_ID = ThreadId.make("thread-train");
const MESSAGE_ID = MessageId.make("message-train");
const COMMAND_ID = CommandId.make("command-train");
const DRAFT_KEY = `${ENVIRONMENT_ID}:${THREAD_ID}`;
const QUEUED_MESSAGE: QueuedThreadMessage = {
  environmentId: ENVIRONMENT_ID,
  threadId: THREAD_ID,
  messageId: MESSAGE_ID,
  commandId: COMMAND_ID,
  text: "Send this after the tunnel",
  attachments: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-07-15T08:00:00.000Z",
};
const THREAD: EnvironmentThreadShell = {
  environmentId: ENVIRONMENT_ID,
  id: THREAD_ID,
  projectId: ProjectId.make("project-train"),
  title: "Train thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-07-15T08:00:00.000Z",
  updatedAt: "2026-07-15T08:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

vi.mock("./thread-outbox", async () => {
  const { Atom: TestAtom } = await import("effect/unstable/reactivity");
  const atoms = {
    queuedMessagesByThreadKeyAtom: TestAtom.make<
      Record<string, ReadonlyArray<QueuedThreadMessage>>
    >({}).pipe(TestAtom.keepAlive),
    deliveryStatesAtom: TestAtom.make<Readonly<Record<string, { readonly _tag: "Pending" }>>>(
      {},
    ).pipe(TestAtom.keepAlive),
    threadShellsAtom: TestAtom.make<ReadonlyArray<EnvironmentThreadShell>>([]).pipe(
      TestAtom.keepAlive,
    ),
  };
  globalThis.__THREAD_OUTBOX_DRAIN_TEST_ATOMS__ = atoms;
  return {
    confirmThreadOutboxMessageQueued: vi.fn(async () => true),
    ensureThreadOutboxLoaded: vi.fn(),
    removeThreadOutboxMessage: vi.fn(),
    threadOutboxRevision: vi.fn(() => 0),
    updateThreadOutboxMessage: vi.fn(async () => true),
    threadOutboxManager: {
      ...atoms,
      begin: mocks.begin,
      complete: mocks.complete,
      fail: vi.fn(),
    },
  };
});

vi.mock("../lib/attachmentUpload", () => ({
  prepareTurnAttachments: async () => ({
    status: "ready" as const,
    attachments: [],
    draftAttachments: [],
    pendingAttachmentIds: [],
    releaseUploads: async () => undefined,
  }),
}));

vi.mock("./use-atom-command", () => ({
  useAtomCommand: () => mocks.startTurn,
}));

vi.mock("./threads", () => {
  return {
    environmentThreadShells: {
      threadShellsAtom: globalThis.__THREAD_OUTBOX_DRAIN_TEST_ATOMS__!.threadShellsAtom,
    },
    threadEnvironment: { startTurn: { label: "test:start-turn" } },
  };
});

vi.mock("./shell", async () => {
  const { Atom: TestAtom } = await import("effect/unstable/reactivity");
  const liveShellAtom = TestAtom.make({ status: "live" as const });
  return {
    environmentShell: { stateValueAtom: () => liveShellAtom },
  };
});

vi.mock("./entities", () => ({
  useProjects: () => [],
  useServerConfigs: () =>
    new Map([
      [
        "environment-train",
        { providers: [], environment: { capabilities: { attachmentUploads: false } } },
      ],
    ]),
  useThreadShells: () => [THREAD],
}));

vi.mock("./server", async () => {
  const { Atom: TestAtom } = await import("effect/unstable/reactivity");
  const config = { providers: [], environment: { capabilities: { attachmentUploads: false } } };
  return { serverEnvironment: { configValueAtom: TestAtom.family(() => TestAtom.make(config)) } };
});

vi.mock("./use-remote-environment-registry", () => ({
  useRemoteConnectionStatus: () => ({
    connectedEnvironments: [
      { environmentId: ENVIRONMENT_ID, connectionState: "connected" as const },
    ],
  }),
}));

vi.mock("./use-thread-outbox", async (importOriginal) => {
  const original = await importOriginal<typeof import("./use-thread-outbox")>();
  return {
    ...original,
    useThreadOutboxShellStatuses: () => new Map([[ENVIRONMENT_ID, "live" as const]]),
  };
});

vi.mock("./use-composer-drafts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./use-composer-drafts")>();
  return { ...original, ensureComposerDraftsLoaded: vi.fn() };
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const testOutbox = globalThis.__THREAD_OUTBOX_DRAIN_TEST_ATOMS__!;

function DrainProbe() {
  useThreadOutboxDrain();
  return null;
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  appAtomRegistry.set(composerDraftsReadyAtom, false);
  appAtomRegistry.set(composerDraftsAtom, {});
  appAtomRegistry.set(testOutbox.queuedMessagesByThreadKeyAtom, {});
  appAtomRegistry.set(testOutbox.deliveryStatesAtom, {});
  appAtomRegistry.set(testOutbox.threadShellsAtom, []);
  mocks.startTurn.mockReset();
  mocks.begin.mockReset();
  mocks.complete.mockReset();
});

describe("useThreadOutboxDrain composer hydration gate", () => {
  it("holds a pending command until hydration and its persisted edit identity are atomically cleared", async () => {
    mocks.begin.mockResolvedValue({
      plan: {
        command: {
          type: "thread.turn.start",
          commandId: COMMAND_ID,
          threadId: THREAD_ID,
          message: {
            messageId: MESSAGE_ID,
            role: "user",
            text: QUEUED_MESSAGE.text,
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: QUEUED_MESSAGE.createdAt,
        },
      },
    });
    mocks.startTurn.mockResolvedValue(AsyncResult.success(undefined));
    mocks.complete.mockImplementation(async () => {
      appAtomRegistry.set(testOutbox.queuedMessagesByThreadKeyAtom, {});
    });
    appAtomRegistry.set(testOutbox.queuedMessagesByThreadKeyAtom, {
      [scopedThreadKey(ENVIRONMENT_ID, THREAD_ID)]: [QUEUED_MESSAGE],
    });
    appAtomRegistry.set(testOutbox.deliveryStatesAtom, {
      [COMMAND_ID]: { _tag: "Pending" },
    });
    appAtomRegistry.set(testOutbox.threadShellsAtom, [THREAD]);

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <RegistryContext.Provider value={appAtomRegistry}>
          <DrainProbe />
        </RegistryContext.Provider>,
      );
    });

    // The environment is already connected, but the persisted composer state
    // is still unknown. Delivery before this boundary could race hydration.
    await flushEffects();
    expect(mocks.startTurn).not.toHaveBeenCalled();

    // Hydration reveals that this exact queued intent is open for editing.
    // Readiness and the durable identity become visible in the same render.
    await act(async () => {
      appAtomRegistry.set(composerDraftsAtom, {
        [DRAFT_KEY]: {
          text: "Edited copy still in the composer",
          attachments: [],
          editingQueuedMessageId: MESSAGE_ID,
        },
      });
      appAtomRegistry.set(composerDraftsReadyAtom, true);
    });
    await flushEffects();
    expect(mocks.startTurn).not.toHaveBeenCalled();

    // Cancel/save clears the copied content and its identity atomically. The
    // original pending intent is now the single eligible source of truth.
    await act(async () => appAtomRegistry.set(composerDraftsAtom, {}));
    await flushEffects();
    expect(mocks.startTurn).toHaveBeenCalledTimes(1);
    expect(mocks.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: ENVIRONMENT_ID,
        input: expect.objectContaining({
          commandId: COMMAND_ID,
          threadId: THREAD_ID,
        }),
      }),
    );
    expect(mocks.complete).toHaveBeenCalledTimes(1);

    await act(async () => {
      appAtomRegistry.set(testOutbox.queuedMessagesByThreadKeyAtom, {});
      await Promise.resolve();
    });
    await flushEffects();
    expect(mocks.startTurn).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });
});
