import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderEvent } from "@t3tools/contracts";
import { LiveStoreStateMirror } from "./livestore/liveStoreEngine";
import { diffStateSnapshots } from "./livestore/parity";
import { PersistenceService } from "./persistenceService";
import { LegacyStateSyncEngine } from "./stateSyncEngineLegacy";
import { ShadowStateSyncEngine } from "./stateSyncEngineShadow";

const tempDirs: string[] = [];
const ISO_BASE_MS = Date.parse("2026-02-19T00:00:00.000Z");

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function iso(offsetMs = 0): string {
  return new Date(ISO_BASE_MS + offsetMs).toISOString();
}

async function waitForMirrorParity(
  readExpected: () => ReturnType<LegacyStateSyncEngine["loadSnapshot"]>,
  readMirror: () => ReturnType<LiveStoreStateMirror["debugReadSnapshot"]>,
): Promise<void> {
  const maxAttempts = 40;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (diffStateSnapshots(readExpected(), readMirror()).length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  expect(diffStateSnapshots(readExpected(), readMirror())).toEqual([]);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("PersistenceService", () => {
  it("stores app settings in metadata with partial updates", () => {
    const stateDir = makeTempDir("t3code-persistence-settings-state-");
    const dbPath = path.join(stateDir, "state.sqlite");
    const service = new PersistenceService({ dbPath });

    try {
      expect(service.getAppSettings()).toEqual({
        codexBinaryPath: "",
        codexHomePath: "",
      });

      expect(
        service.updateAppSettings({
          codexBinaryPath: "  /opt/codex/bin/codex  ",
        }),
      ).toEqual({
        codexBinaryPath: "/opt/codex/bin/codex",
        codexHomePath: "",
      });

      expect(
        service.updateAppSettings({
          codexHomePath: "  /Users/theo/.codex  ",
        }),
      ).toEqual({
        codexBinaryPath: "/opt/codex/bin/codex",
        codexHomePath: "/Users/theo/.codex",
      });
    } finally {
      service.close();
    }

    const reopened = new PersistenceService({ dbPath });
    try {
      expect(reopened.getAppSettings()).toEqual({
        codexBinaryPath: "/opt/codex/bin/codex",
        codexHomePath: "/Users/theo/.codex",
      });
    } finally {
      reopened.close();
    }
  });

  it("persists projects/threads/messages and serves bootstrap + catch-up", () => {
    const stateDir = makeTempDir("t3code-persistence-state-");
    const projectDir = makeTempDir("t3code-persistence-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });

    try {
      const addedProject = service.addProject({ cwd: projectDir });
      expect(addedProject.created).toBe(true);

      const createdThread = service.createThread({
        projectId: addedProject.project.id,
        title: "Thread 1",
        model: "gpt-5.3-codex",
      }).thread;

      service.bindSessionToThread("sess-1", createdThread.id, "runtime-thread-1");
      service.persistUserMessageForTurn({
        sessionId: "sess-1",
        clientMessageId: "msg-user-1",
        clientMessageText: "hello world",
        input: "hello world",
        attachments: [],
      });

      const baseEvent: Omit<ProviderEvent, "id" | "createdAt" | "method" | "payload"> = {
        kind: "notification",
        provider: "codex",
        sessionId: "sess-1",
      };

      service.ingestProviderEvent({
        ...baseEvent,
        id: "evt-1",
        createdAt: iso(10),
        method: "item/started",
        payload: {
          item: {
            type: "agentMessage",
            id: "assistant-msg-1",
            text: "",
          },
        },
      });

      service.ingestProviderEvent({
        ...baseEvent,
        id: "evt-2",
        createdAt: iso(20),
        method: "item/agentMessage/delta",
        itemId: "assistant-msg-1",
        textDelta: "hi",
        payload: {
          itemId: "assistant-msg-1",
          delta: "hi",
        },
      });

      service.ingestProviderEvent({
        ...baseEvent,
        id: "evt-3",
        createdAt: iso(30),
        method: "item/completed",
        payload: {
          item: {
            type: "agentMessage",
            id: "assistant-msg-1",
            text: "hi there",
          },
        },
      });

      service.ingestProviderEvent({
        ...baseEvent,
        id: "evt-4",
        createdAt: iso(40),
        method: "turn/completed",
        turnId: "turn-1",
        payload: {
          turn: {
            id: "turn-1",
            status: "completed",
          },
        },
      });

      const snapshot = service.loadSnapshot();
      expect(snapshot.projects).toHaveLength(1);
      expect(snapshot.threads).toHaveLength(1);
      const thread = snapshot.threads[0];
      expect(thread?.messages.map((message) => message.id)).toEqual([
        "msg-user-1",
        "assistant-msg-1",
      ]);
      expect(thread?.messages[1]?.text).toBe("hi there");
      expect(thread?.turnDiffSummaries[0]?.turnId).toBe("turn-1");
      expect(thread?.turnDiffSummaries[0]?.assistantMessageId).toBe("assistant-msg-1");

      const catchUp = service.catchUp({ afterSeq: 0 });
      expect(catchUp.events.length).toBeGreaterThan(0);
      const sequences = catchUp.events.map((event) => event.seq);
      expect(sequences.every((sequence) => Number.isInteger(sequence))).toBe(true);
      for (let index = 1; index < sequences.length; index += 1) {
        expect(sequences[index]).toBeGreaterThan(sequences[index - 1] ?? Number.NEGATIVE_INFINITY);
      }
      expect(catchUp.events.some((event) => event.eventType === "project.upsert")).toBe(true);
      expect(catchUp.events.some((event) => event.eventType === "thread.upsert")).toBe(true);
      expect(catchUp.events.some((event) => event.eventType === "message.upsert")).toBe(true);
    } finally {
      service.close();
    }
  });

  it("stores turn diff summaries parsed from checkpoint diffs", () => {
    const stateDir = makeTempDir("t3code-persistence-diff-state-");
    const projectDir = makeTempDir("t3code-persistence-diff-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });

    try {
      const project = service.addProject({ cwd: projectDir }).project;
      const thread = service.createThread({
        projectId: project.id,
        title: "Thread 1",
        model: "gpt-5.3-codex",
      }).thread;
      service.bindSessionToThread("sess-1", thread.id, "runtime-thread-1");

      service.persistTurnDiffSummaryFromCheckpoint({
        sessionId: "sess-1",
        runtimeThreadId: "runtime-thread-1",
        turnId: "turn-1",
        checkpointTurnCount: 1,
        completedAt: "2026-02-19T00:00:00.000Z",
        status: "completed",
        diff: [
          "diff --git a/src/app.ts b/src/app.ts",
          "index 1111111..2222222 100644",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1,1 +1,2 @@",
          "-console.log('a')",
          "+console.log('b')",
          "+console.log('c')",
        ].join("\n"),
      });

      service.ingestProviderEvent({
        id: "evt-agent-msg-1",
        kind: "notification",
        provider: "codex",
        sessionId: "sess-1",
        createdAt: "2026-02-19T00:00:01.000Z",
        method: "item/completed",
        turnId: "turn-1",
        itemId: "assistant-msg-1",
        payload: {
          item: {
            type: "agentMessage",
            id: "assistant-msg-1",
            text: "done",
          },
          threadId: "runtime-thread-1",
          turnId: "turn-1",
        },
      });

      const snapshot = service.loadSnapshot();
      const summary = snapshot.threads[0]?.turnDiffSummaries[0];
      expect(summary?.turnId).toBe("turn-1");
      expect(summary?.checkpointTurnCount).toBe(1);
      expect(summary?.assistantMessageId).toBe("assistant-msg-1");
      expect(summary?.files[0]?.path).toBe("src/app.ts");
      expect(summary?.files[0]?.additions).toBe(2);
      expect(summary?.files[0]?.deletions).toBe(1);
    } finally {
      service.close();
    }
  });

  it("advances listMessages.nextOffset by fetched row count even when rows fail to parse", () => {
    const stateDir = makeTempDir("t3code-persistence-list-messages-state-");
    const projectDir = makeTempDir("t3code-persistence-list-messages-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });

    try {
      const project = service.addProject({ cwd: projectDir }).project;
      const thread = service.createThread({
        projectId: project.id,
        title: "Thread 1",
        model: "gpt-5.3-codex",
      }).thread;
      service.bindSessionToThread("sess-1", thread.id, "runtime-thread-1");

      service.persistUserMessageForTurn({
        sessionId: "sess-1",
        clientMessageId: "msg-1",
        clientMessageText: "first",
        input: "first",
        attachments: [],
      });
      service.persistUserMessageForTurn({
        sessionId: "sess-1",
        clientMessageId: "msg-2",
        clientMessageText: "second",
        input: "second",
        attachments: [],
      });

      const db = (
        service as unknown as {
          db: { prepare: (sql: string) => { run: (...params: unknown[]) => unknown } };
        }
      ).db;
      db.prepare("UPDATE documents SET data_json = ? WHERE id = ?;").run(
        "{bad-json",
        `message:${thread.id}:msg-1`,
      );

      const firstPage = service.listMessages({
        threadId: thread.id,
        limit: 1,
        offset: 0,
      });
      expect(firstPage.messages).toEqual([]);
      expect(firstPage.total).toBe(2);
      expect(firstPage.nextOffset).toBe(1);

      const secondPage = service.listMessages({
        threadId: thread.id,
        limit: 1,
        offset: firstPage.nextOffset ?? 0,
      });
      expect(secondPage.messages.map((message) => message.id)).toEqual(["msg-2"]);
      expect(secondPage.nextOffset).toBeNull();
    } finally {
      service.close();
    }
  });

  it("does not throw when state event listeners fail after commit", () => {
    const stateDir = makeTempDir("t3code-persistence-state-events-");
    const projectDir = makeTempDir("t3code-persistence-state-events-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });

    try {
      service.on("stateEvent", () => {
        throw new Error("listener failed");
      });

      const result = service.addProject({ cwd: projectDir });
      expect(result.created).toBe(true);
      expect(service.listProjects()).toHaveLength(1);
    } finally {
      service.close();
    }
  });

  it("preserves checkpointTurnCount=0 when merging turn summaries", () => {
    const stateDir = makeTempDir("t3code-persistence-checkpoint-zero-state-");
    const projectDir = makeTempDir("t3code-persistence-checkpoint-zero-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });

    try {
      const project = service.addProject({ cwd: projectDir }).project;
      const thread = service.createThread({
        projectId: project.id,
        title: "Thread 1",
        model: "gpt-5.3-codex",
      }).thread;
      service.bindSessionToThread("sess-1", thread.id, "runtime-thread-1");

      service.persistTurnDiffSummaryFromCheckpoint({
        sessionId: "sess-1",
        runtimeThreadId: "runtime-thread-1",
        turnId: "turn-1",
        checkpointTurnCount: 0,
        completedAt: "2026-02-19T00:00:00.000Z",
        diff: "",
      });

      service.ingestProviderEvent({
        id: "evt-assistant-completed",
        kind: "notification",
        provider: "codex",
        sessionId: "sess-1",
        createdAt: "2026-02-19T00:00:01.000Z",
        method: "item/completed",
        turnId: "turn-1",
        payload: {
          item: {
            type: "agentMessage",
            id: "assistant-msg-1",
            text: "done",
          },
        },
      });

      const snapshot = service.loadSnapshot();
      const summary = snapshot.threads[0]?.turnDiffSummaries.find(
        (entry) => entry.turnId === "turn-1",
      );
      expect(summary?.checkpointTurnCount).toBe(0);
      expect(summary?.assistantMessageId).toBe("assistant-msg-1");
    } finally {
      service.close();
    }
  });

  it("does not let out-of-order item/started overwrite accumulated assistant text", () => {
    const stateDir = makeTempDir("t3code-persistence-item-order-state-");
    const projectDir = makeTempDir("t3code-persistence-item-order-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });

    try {
      const project = service.addProject({ cwd: projectDir }).project;
      const thread = service.createThread({
        projectId: project.id,
        title: "Thread 1",
        model: "gpt-5.3-codex",
      }).thread;
      service.bindSessionToThread("sess-1", thread.id, "runtime-thread-1");

      service.ingestProviderEvent({
        id: "evt-delta",
        kind: "notification",
        provider: "codex",
        sessionId: "sess-1",
        createdAt: "2026-02-19T00:00:02.000Z",
        method: "item/agentMessage/delta",
        itemId: "assistant-msg-1",
        textDelta: "hello",
        payload: {
          itemId: "assistant-msg-1",
          delta: "hello",
        },
      });

      service.ingestProviderEvent({
        id: "evt-started-late",
        kind: "notification",
        provider: "codex",
        sessionId: "sess-1",
        createdAt: "2026-02-19T00:00:03.000Z",
        method: "item/started",
        payload: {
          item: {
            type: "agentMessage",
            id: "assistant-msg-1",
            text: "",
          },
        },
      });

      const messages = service.listMessages({
        threadId: thread.id,
        limit: 10,
        offset: 0,
      }).messages;
      const assistantMessage = messages.find((message) => message.id === "assistant-msg-1");
      expect(assistantMessage?.text).toBe("hello");
    } finally {
      service.close();
    }
  });

  it("maintains shadow mirror parity across checkpoint revert effects", async () => {
    const stateDir = makeTempDir("t3code-persistence-shadow-parity-state-");
    const projectDir = makeTempDir("t3code-persistence-shadow-parity-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });
    const legacy = new LegacyStateSyncEngine({ persistenceService: service });
    const mirror = new LiveStoreStateMirror({ storeId: "persistence-shadow-parity-test" });
    const shadow = new ShadowStateSyncEngine({
      delegate: legacy,
      mirror,
    });

    try {
      const project = shadow.addProject({ cwd: projectDir }).project;
      const thread = shadow.createThread({
        projectId: project.id,
        title: "checkpoint parity thread",
        model: "gpt-5.3-codex",
      }).thread;
      service.bindSessionToThread("sess-shadow", thread.id, "runtime-thread-shadow");

      service.persistUserMessageForTurn({
        sessionId: "sess-shadow",
        clientMessageId: "msg-1",
        clientMessageText: "first",
        input: "first",
        attachments: [],
      });
      service.persistUserMessageForTurn({
        sessionId: "sess-shadow",
        clientMessageId: "msg-2",
        clientMessageText: "second",
        input: "second",
        attachments: [],
      });

      service.persistTurnDiffSummaryFromCheckpoint({
        sessionId: "sess-shadow",
        runtimeThreadId: "runtime-thread-shadow",
        turnId: "turn-1",
        checkpointTurnCount: 1,
        completedAt: iso(100),
        diff: "",
      });
      service.persistTurnDiffSummaryFromCheckpoint({
        sessionId: "sess-shadow",
        runtimeThreadId: "runtime-thread-shadow",
        turnId: "turn-2",
        checkpointTurnCount: 2,
        completedAt: iso(200),
        diff: "",
      });

      shadow.applyCheckpointRevert({
        sessionId: "sess-shadow",
        runtimeThreadId: "runtime-thread-shadow",
        turnCount: 1,
        messageCount: 1,
      });

      await waitForMirrorParity(() => legacy.loadSnapshot(), () => mirror.debugReadSnapshot());

      const mirrored = mirror.debugReadSnapshot();
      expect(mirrored.threads[0]?.messages.map((message) => message.id)).toEqual(["msg-1"]);
      expect(mirrored.threads[0]?.turnDiffSummaries.map((summary) => summary.turnId)).toEqual([
        "turn-1",
      ]);
      expect(diffStateSnapshots(legacy.loadSnapshot(), mirrored)).toEqual([]);
    } finally {
      shadow.close();
    }
  });

});
