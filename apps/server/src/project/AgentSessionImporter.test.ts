import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  type AgentSessionImportSource,
  type OrchestrationV2DomainEvent,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import { importRecentAgentThreads } from "./AgentSessionImporter.ts";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("project-import");
const providerInstanceId = ProviderInstanceId.make("codex");
const project: Project = {
  id: projectId,
  title: "Imported project",
  workspaceRoot: "/workspace/project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const source: AgentSessionImportSource = {
  provider: "codex",
  providerInstanceId,
  providerSessionId: "native-session-1",
  filePath: "/home/user/.codex/sessions/native-session-1.jsonl",
  size: 512,
  mtimeMs: 1_767_225_600_000,
  device: 1,
  inode: 42,
  birthtimeMs: 1_767_225_590_000,
};

const makeThread = (): Extract<AgentSessionScanner.AgentSessionRecentThread, { readonly _tag: "Importable" }> => ({
  _tag: "Importable",
  source,
  thread: {
    source: "codex",
    providerInstanceId,
    providerSessionId: source.providerSessionId,
    title: "Existing Codex session",
    model: "gpt-5-codex",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    messages: [
      {
        role: "user",
        text: "Continue the migration",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        role: "assistant",
        text: "I found the migration checkpoint.",
        createdAt: "2026-01-01T00:01:00.000Z",
      },
    ],
  },
});

it.effect("imports external transcripts as resumable native V2 history", () => {
  const writes: Array<ReadonlyArray<OrchestrationV2DomainEvent>> = [];
  const scanner = {
    recentThreads: () => Stream.fromIterable([makeThread()]),
  };
  const threadManagement = {
    listProjectThreads: () => Effect.succeed([]),
    getThreadProjection: () => Effect.fail("thread is not imported yet"),
  };
  const eventSink = {
    write: ({ events }: { readonly events: ReadonlyArray<OrchestrationV2DomainEvent> }) =>
      Effect.sync(() => {
        writes.push(events);
        return [];
      }),
  };
  const ids = {
    derive: {
      providerThread: () => ProviderThreadId.make("provider-thread-imported"),
    },
  };
  const projectService = {
    getById: () => Effect.succeed(Option.some(project)),
  };

  return importRecentAgentThreads({
    projectId,
    expectedWorkspaceRoot: "/workspace/project",
  }).pipe(
    Effect.provideService(
      ProjectService.ProjectService,
      projectService as unknown as ProjectService.ProjectService["Service"],
    ),
    Effect.provideService(
      AgentSessionScanner.AgentSessionScanner,
      scanner as unknown as AgentSessionScanner.AgentSessionScanner["Service"],
    ),
    Effect.provideService(
      ThreadManagement.ThreadManagementService,
      threadManagement as unknown as ThreadManagement.ThreadManagementService["Service"],
    ),
    Effect.provideService(
      EventSink.EventSinkV2,
      eventSink as unknown as EventSink.EventSinkV2["Service"],
    ),
    Effect.provideService(
      IdAllocator.IdAllocatorV2,
      ids as unknown as IdAllocator.IdAllocatorV2["Service"],
    ),
    Effect.tap((result) =>
      Effect.sync(() => {
        assert.deepStrictEqual(result, { importedCount: 1, skippedCount: 0 });
        assert.equal(writes.length, 1);
        const events = writes[0] ?? [];
        const created = events.find((event) => event.type === "thread.created");
        const provider = events.find((event) => event.type === "provider-thread.updated");
        const messages = events.filter((event) => event.type === "message.updated");
        assert.isDefined(created);
        assert.isDefined(provider);
        assert.equal(messages.length, 2);
        if (created?.type === "thread.created") {
          assert.equal(created.payload.activeProviderThreadId, "provider-thread-imported");
          assert.equal(created.payload.title, "Existing Codex session");
        }
        if (provider?.type === "provider-thread.updated") {
          assert.equal(provider.payload.providerSessionId, null);
          assert.equal(provider.payload.nativeThreadRef?.nativeId, source.providerSessionId);
          assert.equal(provider.payload.nativeThreadRef?.strength, "strong");
        }
        if (messages[0]?.type === "message.updated") {
          assert.equal(messages[0].payload.text, "Continue the migration");
          assert.equal(messages[0].payload.id.startsWith("import:"), true);
        }
      }),
    ),
  );
});

it.effect("rejects importing into a project whose workspace changed", () => {
  const scanner = {
    recentThreads: () => Stream.die("scanner should not run"),
  };
  const projectService = {
    getById: () => Effect.succeed(Option.some(project)),
  };

  return importRecentAgentThreads({
    projectId,
    expectedWorkspaceRoot: "/workspace/other",
  }).pipe(
    Effect.provideService(
      ProjectService.ProjectService,
      projectService as unknown as ProjectService.ProjectService["Service"],
    ),
    Effect.provideService(
      AgentSessionScanner.AgentSessionScanner,
      scanner as unknown as AgentSessionScanner.AgentSessionScanner["Service"],
    ),
    Effect.provideService(
      ThreadManagement.ThreadManagementService,
      {} as ThreadManagement.ThreadManagementService["Service"],
    ),
    Effect.provideService(EventSink.EventSinkV2, {} as EventSink.EventSinkV2["Service"]),
    Effect.provideService(IdAllocator.IdAllocatorV2, {} as IdAllocator.IdAllocatorV2["Service"]),
    Effect.flip,
    Effect.tap((error) =>
      Effect.sync(() => {
        assert.equal(error._tag, "AgentSessionImportProjectChangedError");
      }),
    ),
  );
});
