import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { expect, it } from "@effect/vitest";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import type { ProviderInstanceRegistryShape } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "./Services/ProviderSessionDirectory.ts";
import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryShape,
} from "./Services/ProviderSessionDirectory.ts";
import {
  chunkStoredThreadMessagesForSync,
  selectMissingStoredThreadMessages,
  syncCodexStoredThreadByThreadId,
} from "./codexStoredThreadSync.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import type { ProviderStoredThreadMessage } from "./Services/ProviderAdapter.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const codexProvider = ProviderDriverKind.make("codex");
const codexInstanceId = ProviderInstanceId.make("codex");

function storedMessage(
  input: Pick<ProviderStoredThreadMessage, "messageId" | "role" | "text"> &
    Partial<Pick<ProviderStoredThreadMessage, "turnId">>,
): ProviderStoredThreadMessage {
  return {
    messageId: input.messageId,
    role: input.role,
    text: input.text,
    turnId: input.turnId ?? TurnId.make("turn-1"),
    streaming: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function projectedMessage(
  input: Pick<OrchestrationMessage, "id" | "role" | "text"> &
    Partial<Pick<OrchestrationMessage, "turnId">>,
): OrchestrationMessage {
  return {
    id: input.id,
    role: input.role,
    text: input.text,
    turnId: input.turnId ?? null,
    streaming: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

it("selects only stored Codex messages not already represented in T3", () => {
  const missing = selectMissingStoredThreadMessages(
    [
      storedMessage({
        messageId: MessageId.make("codex:thread:user-1"),
        role: "user",
        text: "Already imported by provider id",
      }),
      storedMessage({
        messageId: MessageId.make("codex:thread:user-2"),
        role: "user",
        text: "Already present from T3",
      }),
      storedMessage({
        messageId: MessageId.make("assistant:item-3"),
        role: "assistant",
        text: "New Codex reply",
      }),
    ],
    [
      projectedMessage({
        id: MessageId.make("codex:thread:user-1"),
        role: "user",
        text: "Already imported by provider id",
        turnId: TurnId.make("turn-1"),
      }),
      projectedMessage({
        id: MessageId.make("local-user-message"),
        role: "user",
        text: "Already present from T3",
      }),
    ],
  );

  expect(missing.map((message) => message.messageId)).toEqual([MessageId.make("assistant:item-3")]);
});

it("preserves repeated same-text messages by comparing occurrence counts", () => {
  const missing = selectMissingStoredThreadMessages(
    [
      storedMessage({
        messageId: MessageId.make("codex:thread:user-1"),
        role: "user",
        text: "Again",
      }),
      storedMessage({
        messageId: MessageId.make("codex:thread:user-2"),
        role: "user",
        text: "Again",
      }),
    ],
    [
      projectedMessage({
        id: MessageId.make("local-user-message"),
        role: "user",
        text: "Again",
      }),
    ],
  );

  expect(missing.map((message) => message.messageId)).toEqual([
    MessageId.make("codex:thread:user-2"),
  ]);
});

it("selects existing Codex messages when stored timestamps need repair", () => {
  const repairedTimestamp = "2026-01-01T00:00:02.000Z";
  const missing = selectMissingStoredThreadMessages(
    [
      {
        ...storedMessage({
          messageId: MessageId.make("assistant:item-1"),
          role: "assistant",
          text: "Answer",
        }),
        createdAt: repairedTimestamp,
        updatedAt: repairedTimestamp,
      },
    ],
    [
      projectedMessage({
        id: MessageId.make("assistant:item-1"),
        role: "assistant",
        text: "Answer",
      }),
    ],
  );

  expect(missing.map((message) => message.messageId)).toEqual([MessageId.make("assistant:item-1")]);
  expect(missing[0]?.createdAt).toBe(repairedTimestamp);
});

it("splits stored message sync into small batches", () => {
  const messages = Array.from({ length: 61 }, (_, index) =>
    storedMessage({
      messageId: MessageId.make(`assistant:item-${index}`),
      role: "assistant",
      text: `Answer ${index}`,
    }),
  );

  const batches = chunkStoredThreadMessagesForSync(messages);

  expect(batches.map((batch) => batch.length)).toEqual([25, 25, 11]);
});

it.layer(NodeServices.layer)("targeted stored Codex thread sync", (it) => {
  it.effect("hydrates missing messages for a shell thread with an existing binding", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("local-thread-1");
      const providerThreadId = "codex-thread-1";
      const dispatchedCommands: OrchestrationCommand[] = [];
      const upsertedBindings: ProviderRuntimeBinding[] = [];
      const existingThread: OrchestrationThread = {
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Imported shell",
        modelSelection: {
          instanceId: codexInstanceId,
          model: DEFAULT_MODEL,
        },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      };

      const adapter = {
        getStoredThread: () =>
          Effect.succeed({
            providerThreadId,
            title: "Hydrated Codex thread",
            cwd: "/tmp/project-1",
            preview: "New Codex-side prompt",
            createdAt: timestamp,
            updatedAt: timestamp,
            messages: [
              storedMessage({
                messageId: MessageId.make("codex:codex-thread-1:user-1"),
                role: "user",
                text: "New Codex-side prompt",
                turnId: TurnId.make("turn-1"),
              }),
            ],
          }),
      } satisfies Pick<ProviderInstance["adapter"], "getStoredThread">;

      const layer = Layer.mergeAll(
        Layer.succeed(ProviderSessionDirectory, {
          getBinding: () =>
            Effect.succeed(
              Option.some({
                threadId,
                provider: codexProvider,
                providerInstanceId: codexInstanceId,
                runtimeMode: "full-access",
                status: "stopped",
                resumeCursor: { threadId: providerThreadId },
              }),
            ),
          upsert: (binding) =>
            Effect.sync(() => {
              upsertedBindings.push(binding);
            }),
          getProvider: () => Effect.succeed(codexProvider),
          listThreadIds: () => Effect.succeed([threadId]),
          listBindings: () => Effect.succeed([]),
        } satisfies ProviderSessionDirectoryShape),
        Layer.succeed(ProviderInstanceRegistry, {
          getInstance: () => Effect.sync(() => undefined),
          listInstances: Effect.succeed([
            {
              instanceId: codexInstanceId,
              driverKind: codexProvider,
              continuationIdentity: {
                driverKind: codexProvider,
                continuationKey: "codex:instance:codex",
              },
              displayName: "Codex",
              enabled: true,
              adapter: adapter as unknown as ProviderInstance["adapter"],
              snapshot: {} as ProviderInstance["snapshot"],
              textGeneration: {} as ProviderInstance["textGeneration"],
            },
          ]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.die("not used"),
        } satisfies ProviderInstanceRegistryShape),
        Layer.succeed(ProjectionSnapshotQuery, {
          getThreadDetailById: () => Effect.succeed(Option.some(existingThread)),
        } as unknown as ProjectionSnapshotQueryShape),
        Layer.succeed(OrchestrationEngineService, {
          dispatch: (command) =>
            Effect.sync(() => {
              dispatchedCommands.push(command);
              return { sequence: dispatchedCommands.length };
            }),
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
        } satisfies OrchestrationEngineShape),
      );

      const result = yield* syncCodexStoredThreadByThreadId(threadId).pipe(Effect.provide(layer));

      expect(result).toMatchObject({ hydrated: true, syncedMessages: 1 });
      expect(dispatchedCommands).toHaveLength(1);
      expect(dispatchedCommands[0]).toMatchObject({
        type: "thread.messages.sync",
        threadId,
      });
      expect(upsertedBindings[0]?.resumeCursor).toEqual({ threadId: providerThreadId });
    }),
  );
});
