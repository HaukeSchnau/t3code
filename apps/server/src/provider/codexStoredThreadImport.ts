import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type ModelSelection,
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
import type { ProviderRuntimeBindingWithMetadata } from "./Services/ProviderSessionDirectory.ts";
import type { ProviderStoredThreadSummary } from "./Services/ProviderAdapter.ts";

const CODEX_PROVIDER = ProviderDriverKind.make("codex");

function readCodexResumeThreadId(binding: ProviderRuntimeBindingWithMetadata): string | undefined {
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

export const importCodexStoredThreads = Effect.fn("importCodexStoredThreads")(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const projection = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const sessionDirectory = yield* ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4;

  const bindings = yield* sessionDirectory.listBindings();
  const existingCodexResumeThreadIds = new Set(
    bindings
      .filter((binding) => binding.provider === CODEX_PROVIDER)
      .map(readCodexResumeThreadId)
      .filter((threadId): threadId is string => threadId !== undefined),
  );

  const importOneThread = Effect.fn("importCodexStoredThreads.importOneThread")(function* (input: {
    readonly instanceId: ModelSelection["instanceId"];
    readonly thread: ProviderStoredThreadSummary;
  }) {
    const existingThread = yield* projection.getThreadShellById(
      ThreadId.make(input.thread.providerThreadId),
    );
    if (
      existingCodexResumeThreadIds.has(input.thread.providerThreadId) ||
      Option.isSome(existingThread)
    ) {
      return false;
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

    const threadId = ThreadId.make(input.thread.providerThreadId);
    yield* engine.dispatch({
      type: "thread.import",
      commandId: CommandId.make(yield* randomId),
      threadId,
      projectId,
      title: input.thread.title,
      modelSelection: modelSelectionForCodexInstance(input.instanceId),
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      messages: input.thread.messages.map((message) => ({ ...message })),
      createdAt: input.thread.createdAt,
      updatedAt: input.thread.updatedAt,
    });

    yield* sessionDirectory.upsert({
      threadId,
      provider: CODEX_PROVIDER,
      providerInstanceId: input.instanceId,
      runtimeMode: "full-access",
      status: "stopped",
      resumeCursor: { threadId: input.thread.providerThreadId },
      runtimePayload: {
        cwd: input.thread.cwd,
        modelSelection: modelSelectionForCodexInstance(input.instanceId),
        lastRuntimeEvent: "codex.thread.import",
        lastRuntimeEventAt: yield* nowIso,
      },
    });
    existingCodexResumeThreadIds.add(input.thread.providerThreadId);
    return true;
  });

  let importedCount = 0;
  const instances = yield* registry.listInstances;
  for (const instance of instances) {
    if (instance.driverKind !== CODEX_PROVIDER || !instance.enabled) {
      continue;
    }
    const listStoredThreads = instance.adapter.listStoredThreads;
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
    for (const thread of threads) {
      const imported = yield* importOneThread({
        instanceId: instance.instanceId,
        thread,
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to import Codex stored thread", {
            providerInstanceId: instance.instanceId,
            providerThreadId: thread.providerThreadId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (imported) {
        importedCount += 1;
      }
    }
  }

  if (importedCount > 0) {
    yield* Effect.logInfo("imported Codex stored threads", { count: importedCount });
  }
  return importedCount;
});
