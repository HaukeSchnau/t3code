import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { StateEvent } from "@t3tools/contracts";
import { PersistenceService } from "./persistenceService";
import { LegacyStateSyncEngine } from "./stateSyncEngineLegacy";
import type { StateEventMirror } from "./stateSyncEngineShadow";
import { ShadowStateSyncEngine } from "./stateSyncEngineShadow";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

class CapturingMirror implements StateEventMirror {
  readonly events: StateEvent[] = [];
  disposeCalls = 0;

  async mirrorStateEvent(event: StateEvent): Promise<void> {
    this.events.push(event);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ShadowStateSyncEngine", () => {
  it("delegates durable APIs and mirrors emitted state events", async () => {
    const stateDir = makeTempDir("t3code-shadow-state-");
    const projectDir = makeTempDir("t3code-shadow-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });
    const legacy = new LegacyStateSyncEngine({ persistenceService: service });
    const mirror = new CapturingMirror();
    const shadow = new ShadowStateSyncEngine({
      delegate: legacy,
      mirror,
    });

    try {
      const observedEvents: StateEvent[] = [];
      const unsubscribe = shadow.onStateEvent((event) => {
        observedEvents.push(event);
      });

      const project = shadow.addProject({ cwd: projectDir }).project;
      const thread = shadow.createThread({
        projectId: project.id,
        title: "Shadow thread",
      }).thread;
      shadow.updateThreadTitle({
        threadId: thread.id,
        title: "Shadow thread updated",
      });
      service.bindSessionToThread("shadow-session", thread.id, "runtime-thread-1");
      service.persistUserMessageForTurn({
        sessionId: "shadow-session",
        clientMessageId: "msg-1",
        clientMessageText: "hello from shadow",
        input: "hello from shadow",
        attachments: [],
      });

      await Promise.resolve();

      const snapshot = shadow.loadSnapshot();
      expect(snapshot.projects).toHaveLength(1);
      expect(snapshot.threads).toHaveLength(1);
      expect(snapshot.threads[0]?.title).toBe("Shadow thread updated");

      const catchUp = shadow.catchUp({ afterSeq: 0 });
      expect(catchUp.events.length).toBeGreaterThan(0);
      expect(catchUp.events.map((event) => event.eventType)).toEqual(
        expect.arrayContaining(["project.upsert", "thread.upsert"]),
      );

      expect(mirror.events.map((event) => event.seq)).toEqual(
        observedEvents.map((event) => event.seq),
      );
      expect(mirror.events.some((event) => event.eventType === "message.upsert")).toBe(true);
      expect(observedEvents.some((event) => event.eventType === "message.upsert")).toBe(true);

      unsubscribe();
    } finally {
      shadow.close();
      service.close();
    }
  });

  it("stops mirroring and disposes once on close", async () => {
    const stateDir = makeTempDir("t3code-shadow-close-state-");
    const projectDir = makeTempDir("t3code-shadow-close-project-");
    const service = new PersistenceService({
      dbPath: path.join(stateDir, "state.sqlite"),
    });
    const legacy = new LegacyStateSyncEngine({ persistenceService: service });
    const mirror = new CapturingMirror();
    const shadow = new ShadowStateSyncEngine({
      delegate: legacy,
      mirror,
    });

    try {
      shadow.close();
      shadow.close();

      legacy.addProject({ cwd: projectDir });
      await Promise.resolve();
      expect(mirror.events).toHaveLength(0);
      expect(mirror.disposeCalls).toBe(1);
    } finally {
      service.close();
    }
  });
});
