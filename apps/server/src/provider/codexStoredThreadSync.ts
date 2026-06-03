import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type ModelSelection,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "./Services/ProviderSessionDirectory.ts";
import type {
  ProviderRuntimeBinding,
  ProviderRuntimeBindingWithMetadata,
} from "./Services/ProviderSessionDirectory.ts";
import type {
  ProviderStoredThreadMessage,
  ProviderStoredThreadSummary,
} from "./Services/ProviderAdapter.ts";

const CODEX_PROVIDER = ProviderDriverKind.make("codex");
const STORED_THREAD_MESSAGE_SYNC_BATCH_SIZE = 25;

function readCodexResumeThreadId(
  binding: ProviderRuntimeBinding | ProviderRuntimeBindingWithMetadata,
): string | undefined {
  const cursor = binding.resumeCursor;
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
    return undefined;
  }
  const value = "threadId" in cursor ? cursor.threadId : undefined;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function projectTitleFromCwd(path: Path.Path, cwd: string): string {
  const title = path.basename(cwd.trim());
  return title.length > 0 ? title : cwd;
}

function modelSelectionForCodexInstance(instanceId: ModelSelection["instanceId"]): ModelSelection {
  return {
    instanceId,
    model: DEFAULT_MODEL,
  };
}

function normalizedMessageText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function messageContentKey(
  message: Pick<OrchestrationMessage | ProviderStoredThreadMessage, "role" | "text">,
): string {
  return `${message.role}\u0000${normalizedMessageText(message.text)}`;
}

function storedMessageMatchesExisting(
  stored: ProviderStoredThreadMessage,
  existing: OrchestrationMessage,
): boolean {
  return (
    existing.role === stored.role &&
    normalizedMessageText(existing.text) === normalizedMessageText(stored.text) &&
    existing.turnId === stored.turnId &&
    existing.streaming === stored.streaming &&
    existing.createdAt === stored.createdAt &&
    existing.updatedAt === stored.updatedAt
  );
}

function incrementCount(map: Map<string, number>, key: string): number {
  const next = (map.get(key) ?? 0) + 1;
  map.set(key, next);
  return next;
}

export function chunkStoredThreadMessagesForSync(
  messages: ReadonlyArray<ProviderStoredThreadMessage>,
): ReadonlyArray<ReadonlyArray<ProviderStoredThreadMessage>> {
  const chunks: Array<ReadonlyArray<ProviderStoredThreadMessage>> = [];
  for (let index = 0; index < messages.length; index += STORED_THREAD_MESSAGE_SYNC_BATCH_SIZE) {
    chunks.push(messages.slice(index, index + STORED_THREAD_MESSAGE_SYNC_BATCH_SIZE));
  }
  return chunks;
}

function toStoredThreadShell(thread: ProviderStoredThreadSummary): ProviderStoredThreadSummary {
  return {
    ...thread,
    messages: [],
  };
}

export function selectMissingStoredThreadMessages(
  storedMessages: ReadonlyArray<ProviderStoredThreadMessage>,
  existingMessages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<ProviderStoredThreadMessage> {
  const existingMessageById = new Map(existingMessages.map((message) => [message.id, message]));
  const existingContentCounts = new Map<string, number>();
  for (const message of existingMessages) {
    incrementCount(existingContentCounts, messageContentKey(message));
  }

  const seenStoredContentCounts = new Map<string, number>();
  const missing: ProviderStoredThreadMessage[] = [];
  for (const message of storedMessages) {
    const key = messageContentKey(message);
    const storedOrdinal = incrementCount(seenStoredContentCounts, key);
    const existingMessage = existingMessageById.get(message.messageId);
    if (existingMessage !== undefined) {
      if (!storedMessageMatchesExisting(message, existingMessage)) {
        missing.push(message);
      }
      continue;
    }
    if ((existingContentCounts.get(key) ?? 0) >= storedOrdinal) {
      continue;
    }
    missing.push(message);
  }
  return missing;
}

export const syncCodexStoredThreads = Effect.fn("syncCodexStoredThreads")(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const projection = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const sessionDirectory = yield* ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4;

  const bindings = yield* sessionDirectory.listBindings();
  const codexBindingByProviderThreadId = new Map<string, ProviderRuntimeBindingWithMetadata>();
  for (const binding of bindings) {
    if (binding.provider !== CODEX_PROVIDER) {
      continue;
    }
    const providerThreadId = readCodexResumeThreadId(binding);
    if (providerThreadId) {
      codexBindingByProviderThreadId.set(providerThreadId, binding);
    }
  }

  const upsertCodexBinding = Effect.fn("syncCodexStoredThreads.upsertCodexBinding")(
    function* (input: {
      readonly instanceId: ModelSelection["instanceId"];
      readonly threadId: ThreadId;
      readonly thread: ProviderStoredThreadSummary;
      readonly status?: ProviderRuntimeBindingWithMetadata["status"];
      readonly runtimeMode?: ProviderRuntimeBindingWithMetadata["runtimeMode"];
      readonly lastRuntimeEvent: string;
    }) {
      yield* sessionDirectory.upsert({
        threadId: input.threadId,
        provider: CODEX_PROVIDER,
        providerInstanceId: input.instanceId,
        ...(input.runtimeMode ? { runtimeMode: input.runtimeMode } : {}),
        ...(input.status ? { status: input.status } : { status: "stopped" }),
        resumeCursor: { threadId: input.thread.providerThreadId },
        runtimePayload: {
          cwd: input.thread.cwd,
          modelSelection: modelSelectionForCodexInstance(input.instanceId),
          lastRuntimeEvent: input.lastRuntimeEvent,
          lastRuntimeEventAt: yield* nowIso,
        },
      });
      codexBindingByProviderThreadId.set(input.thread.providerThreadId, {
        threadId: input.threadId,
        provider: CODEX_PROVIDER,
        providerInstanceId: input.instanceId,
        runtimeMode: input.runtimeMode ?? "full-access",
        status: input.status ?? "stopped",
        resumeCursor: { threadId: input.thread.providerThreadId },
        runtimePayload: {
          cwd: input.thread.cwd,
          modelSelection: modelSelectionForCodexInstance(input.instanceId),
        },
        lastSeenAt: yield* nowIso,
      });
    },
  );

  const syncOneThread = Effect.fn("syncCodexStoredThreads.syncOneThread")(function* (input: {
    readonly instanceId: ModelSelection["instanceId"];
    readonly thread: ProviderStoredThreadSummary;
  }) {
    const existingBinding = codexBindingByProviderThreadId.get(input.thread.providerThreadId);
    const threadId = existingBinding?.threadId ?? ThreadId.make(input.thread.providerThreadId);
    const existingThread = yield* projection.getThreadDetailById(threadId);
    const threadShell = toStoredThreadShell(input.thread);

    if (Option.isSome(existingThread)) {
      yield* upsertCodexBinding({
        instanceId: input.instanceId,
        threadId,
        thread: threadShell,
        ...(existingBinding?.status ? { status: existingBinding.status } : {}),
        ...(existingBinding?.runtimeMode ? { runtimeMode: existingBinding.runtimeMode } : {}),
        lastRuntimeEvent: "codex.thread.shell-sync",
      });
      return { imported: false, syncedMessages: 0 };
    }

    if (existingBinding) {
      yield* Effect.logDebug("skipping Codex stored thread with stale T3 binding", {
        providerThreadId: input.thread.providerThreadId,
        threadId,
      });
      return { imported: false, syncedMessages: 0 };
    }

    const existingProject = yield* projection.getActiveProjectByWorkspaceRoot(input.thread.cwd);
    let projectId: ProjectId;
    if (Option.isSome(existingProject)) {
      projectId = existingProject.value.id;
    } else {
      const createdAt = yield* nowIso;
      projectId = ProjectId.make(yield* randomId);
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(yield* randomId),
        projectId,
        title: projectTitleFromCwd(path, input.thread.cwd),
        workspaceRoot: input.thread.cwd,
        defaultModelSelection: modelSelectionForCodexInstance(input.instanceId),
        createdAt,
      });
    }

    yield* engine.dispatch({
      type: "thread.import",
      commandId: CommandId.make(yield* randomId),
      threadId,
      projectId,
      title: threadShell.title,
      modelSelection: modelSelectionForCodexInstance(input.instanceId),
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      messages: [],
      createdAt: threadShell.createdAt,
      updatedAt: threadShell.updatedAt,
    });

    yield* upsertCodexBinding({
      instanceId: input.instanceId,
      threadId,
      runtimeMode: "full-access",
      status: "stopped",
      thread: threadShell,
      lastRuntimeEvent: "codex.thread.shell-import",
    });
    return { imported: true, syncedMessages: 0 };
  });

  let importedCount = 0;
  let syncedMessageCount = 0;
  const instances = yield* registry.listInstances;
  for (const instance of instances) {
    if (instance.driverKind !== CODEX_PROVIDER || !instance.enabled) {
      continue;
    }
    const listStoredThreads = instance.adapter.listStoredThreads;
    const listStoredThreadShells = instance.adapter.listStoredThreadShells;
    if (!listStoredThreads && !listStoredThreadShells) {
      continue;
    }

    const syncThreads = Effect.fn("syncCodexStoredThreads.syncThreads")(function* (
      threads: ReadonlyArray<ProviderStoredThreadSummary>,
    ) {
      for (const thread of threads) {
        const result = yield* syncOneThread({
          instanceId: instance.instanceId,
          thread,
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to sync Codex stored thread", {
              providerInstanceId: instance.instanceId,
              providerThreadId: thread.providerThreadId,
              cause,
            }).pipe(Effect.as({ imported: false, syncedMessages: 0 })),
          ),
        );
        if (result.imported) {
          importedCount += 1;
        }
        syncedMessageCount += result.syncedMessages;
      }
    });

    if (listStoredThreadShells) {
      const threadShells = yield* listStoredThreadShells().pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to list Codex stored thread shells", {
            providerInstanceId: instance.instanceId,
            cause,
          }).pipe(Effect.as([] as ReadonlyArray<ProviderStoredThreadSummary>)),
        ),
      );
      yield* syncThreads(threadShells);
      if (threadShells.length > 0) {
        yield* Effect.logInfo("synced Codex stored thread shells", {
          providerInstanceId: instance.instanceId,
          count: threadShells.length,
        });
      }
      continue;
    }

    if (!listStoredThreads) {
      continue;
    }
    const threads = yield* listStoredThreads().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to list Codex stored threads", {
          providerInstanceId: instance.instanceId,
          cause,
        }).pipe(Effect.as([] as ReadonlyArray<ProviderStoredThreadSummary>)),
      ),
    );
    yield* syncThreads(threads);
  }

  if (importedCount > 0 || syncedMessageCount > 0) {
    yield* Effect.logInfo("synced Codex stored threads", {
      importedCount,
      syncedMessageCount,
    });
  }
  return { importedCount, syncedMessageCount };
});

export const syncCodexStoredThreadByThreadId = Effect.fn("syncCodexStoredThreadByThreadId")(
  function* (threadId: ThreadId) {
    const registry = yield* ProviderInstanceRegistry;
    const projection = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const sessionDirectory = yield* ProviderSessionDirectory;
    const crypto = yield* Crypto.Crypto;
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomId = crypto.randomUUIDv4;

    const bindingOption = yield* sessionDirectory.getBinding(threadId);
    if (Option.isNone(bindingOption)) {
      return { hydrated: false, syncedMessages: 0, reason: "missing-binding" as const };
    }

    const binding = bindingOption.value;
    if (binding.provider !== CODEX_PROVIDER) {
      return { hydrated: false, syncedMessages: 0, reason: "non-codex-binding" as const };
    }

    const providerThreadId = readCodexResumeThreadId(binding);
    if (!providerThreadId) {
      return { hydrated: false, syncedMessages: 0, reason: "missing-provider-thread" as const };
    }

    const existingThread = yield* projection.getThreadDetailById(threadId);
    if (Option.isNone(existingThread)) {
      return { hydrated: false, syncedMessages: 0, reason: "missing-thread" as const };
    }

    const instances = yield* registry.listInstances;
    const instance = instances.find(
      (candidate) =>
        candidate.driverKind === CODEX_PROVIDER &&
        candidate.enabled &&
        candidate.adapter.getStoredThread &&
        (binding.providerInstanceId === undefined ||
          candidate.instanceId === binding.providerInstanceId),
    );
    if (!instance?.adapter.getStoredThread) {
      return { hydrated: false, syncedMessages: 0, reason: "missing-adapter" as const };
    }

    const storedThread = yield* instance.adapter.getStoredThread(providerThreadId);
    if (!storedThread) {
      return { hydrated: false, syncedMessages: 0, reason: "missing-stored-thread" as const };
    }

    const missingMessages = selectMissingStoredThreadMessages(
      storedThread.messages,
      existingThread.value.messages,
    );
    for (const messages of chunkStoredThreadMessagesForSync(missingMessages)) {
      yield* engine.dispatch({
        type: "thread.messages.sync",
        commandId: CommandId.make(yield* randomId),
        threadId,
        messages: [...messages],
      });
    }

    yield* sessionDirectory.upsert({
      threadId,
      provider: CODEX_PROVIDER,
      providerInstanceId: instance.instanceId,
      ...(binding.runtimeMode ? { runtimeMode: binding.runtimeMode } : {}),
      ...(binding.status ? { status: binding.status } : { status: "stopped" }),
      resumeCursor: { threadId: storedThread.providerThreadId },
      runtimePayload: {
        cwd: storedThread.cwd,
        modelSelection: modelSelectionForCodexInstance(instance.instanceId),
        lastRuntimeEvent:
          missingMessages.length > 0 ? "codex.thread.hydrate" : "codex.thread.hydrate.noop",
        lastRuntimeEventAt: yield* nowIso,
      },
    });

    return { hydrated: true, syncedMessages: missingMessages.length };
  },
);
