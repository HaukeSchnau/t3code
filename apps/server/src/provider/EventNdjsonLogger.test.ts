// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { RotatingFileSinkError } from "@t3tools/shared/logging";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";

import {
  makeEventNdjsonLogger,
  makeEventNdjsonLogStore,
  type PendingRecord,
  writeBatchedMessages,
} from "./EventNdjsonLogger.ts";

function parsePayload(line: string): Record<string, unknown> {
  const match = /^\[[^\]]+\] [A-Z]+: (.+)$/.exec(line);
  assert.notEqual(match, null);
  if (!match?.[1]) throw new Error(`invalid provider log line: ${line}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function readLines(filePath: string): ReadonlyArray<string> {
  return NodeFS.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
}

function readEventIds(filePath: string): ReadonlyArray<string | undefined> {
  return readLines(filePath).map((line) => (parsePayload(line).event as { id?: string }).id);
}

it.layer(NodeServices.layer)("EventNdjsonLogger", (it) => {
  it.effect("writes metadata-only records to the exact global stream path", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-")),
      );
      const filePath = NodePath.join(tempDir, "native.log");
      const secret = "secret-provider-output";

      try {
        const logger = yield* makeEventNdjsonLogger(filePath, { stream: "native" });
        assert.exists(logger);
        if (!logger) return;

        yield* logger.write(
          {
            observedAt: "2026-07-13T00:00:00.000Z",
            event: {
              id: "evt-1",
              method: "process/stderr",
              provider: "codex",
              payload: { output: secret },
            },
          },
          ThreadId.make("thread-1"),
        );
        yield* logger.close();

        assert.isTrue(NodeFS.existsSync(filePath));
        assert.isFalse(NodeFS.existsSync(NodePath.join(tempDir, "thread-1.log")));
        const contents = NodeFS.readFileSync(filePath, "utf8");
        assert.notInclude(contents, secret);
        const payload = parsePayload(contents.trim());
        assert.equal(payload.stream, "native");
        assert.equal(payload.threadId, "thread-1");
        assert.deepInclude(payload, {
          event: { name: "process/stderr", id: "evt-1", provider: "codex" },
          body: { valueType: "object", fieldCount: 1 },
        });
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("bounds giant and circular payload metadata", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-")),
      );
      const filePath = NodePath.join(tempDir, "canonical.log");
      const secret = "secret-circular-value";
      const circular: Record<string, unknown> = { secret, delta: "x".repeat(2_000_000) };
      circular.self = circular;

      try {
        const logger = yield* makeEventNdjsonLogger(filePath, { stream: "canonical" });
        assert.exists(logger);
        if (!logger) return;
        yield* logger.write(
          { type: "item.completed", eventId: "evt-giant", payload: circular },
          ThreadId.make("thread-giant"),
        );
        yield* logger.close();

        const contents = NodeFS.readFileSync(filePath, "utf8");
        assert.notInclude(contents, secret);
        assert.notInclude(contents, "x".repeat(100));
        assert.isBelow(Buffer.byteLength(contents), 1_200);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("samples 9,200 high-frequency native events deterministically", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-")),
      );
      const filePath = NodePath.join(tempDir, "native.log");

      try {
        const logger = yield* makeEventNdjsonLogger(filePath, {
          stream: "native",
          batchWindowMs: 0,
        });
        assert.exists(logger);
        if (!logger) return;
        for (let index = 0; index < 9_200; index += 1) {
          yield* logger.write(
            { event: { type: "message.updated", payload: { text: `chunk-${index}` } } },
            ThreadId.make("thread-stress"),
          );
        }
        yield* logger.close();

        const lines = readLines(filePath);
        assert.equal(lines.length, 43);
        const last = parsePayload(lines.at(-1) ?? "");
        assert.deepInclude(last, {
          sampling: { occurrence: 9_216 - 256, suppressedSincePrevious: 255 },
        });
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("drops transient provider events before sampling", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-")),
      );
      const filePath = NodePath.join(tempDir, "events.log");
      const threadId = ThreadId.make("thread-transient");

      try {
        const store = yield* makeEventNdjsonLogStore(filePath, { batchWindowMs: 0 });
        const native = store.logger("native");
        const canonical = store.logger("canonical");
        yield* canonical.write({ type: "content.delta", eventId: "canonical-delta" }, threadId);
        yield* native.write({ event: { id: "raw-frame", stage: "raw", payload: {} } }, threadId);
        yield* native.write(
          {
            event: {
              id: "acp-chunk",
              method: "session/update",
              payload: { update: { sessionUpdate: "agent_message_chunk" } },
            },
          },
          threadId,
        );
        yield* canonical.write({ type: "turn.completed", eventId: "completed" }, threadId);
        yield* store.close();

        assert.deepEqual(readEventIds(filePath), ["completed"]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("bounds oversized records while retaining failure details", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-")),
      );
      const filePath = NodePath.join(tempDir, "native.log");
      // JSON escapes each control character to six bytes.
      const escaped = "\u0000".repeat(128);

      try {
        const logger = yield* makeEventNdjsonLogger(filePath, {
          stream: "native",
          batchWindowMs: 0,
        });
        assert.exists(logger);
        if (!logger) return;
        yield* logger.write(
          {
            event: {
              method: "error",
              id: escaped,
              itemId: escaped,
              provider: "codex",
              turnId: "native-turn",
              payload: { error: { message: "The provider is unavailable." }, output: "x" },
            },
          },
          ThreadId.make("large-error"),
        );
        yield* logger.close();

        const contents = NodeFS.readFileSync(filePath, "utf8");
        assert.isBelow(Buffer.byteLength(contents), 1_200);
        const record = parsePayload(contents.trim());
        assert.equal(record.threadId, "large-error");
        assert.equal(record.metadataTruncated, true);
        assert.deepInclude(record.event as Record<string, unknown>, {
          name: "error",
          provider: "codex",
          turnId: "native-turn",
        });
        assert.deepEqual(record.body, { valueType: "object", fieldCount: 2 });
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("serializes concurrent first writes for the same segment", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-")),
      );
      const filePath = NodePath.join(tempDir, "canonical.log");

      try {
        const logger = yield* makeEventNdjsonLogger(filePath, {
          stream: "canonical",
          batchWindowMs: 0,
        });
        assert.exists(logger);
        if (!logger) return;
        yield* Effect.all(
          [
            logger.write({ id: "evt-concurrent-1" }, null),
            logger.write({ id: "evt-concurrent-2" }, null),
          ],
          { concurrency: "unbounded" },
        );
        yield* logger.close();

        assert.deepEqual(readEventIds(filePath).toSorted(), [
          "evt-concurrent-1",
          "evt-concurrent-2",
        ]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("omits running OpenCode tool snapshots but keeps lifecycle states", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-")),
      );
      const filePath = NodePath.join(tempDir, "native.log");
      const threadId = ThreadId.make("thread-tool-lifecycle");

      try {
        const logger = yield* makeEventNdjsonLogger(filePath, {
          stream: "native",
          batchWindowMs: 0,
        });
        assert.exists(logger);
        if (!logger) return;
        for (const state of ["pending", "running", "completed", "error", "unknown"] as const) {
          yield* logger.write(
            {
              event: {
                id: `tool-${state}`,
                type: "message.part.updated",
                payload: {
                  properties: {
                    part: { type: "tool", state: { status: state, output: `output-${state}` } },
                  },
                },
              },
            },
            threadId,
          );
        }
        yield* logger.close();

        assert.deepEqual(
          readLines(filePath).map((line) => {
            const event = parsePayload(line).event as { readonly id?: string };
            return event.id;
          }),
          ["tool-pending", "tool-completed", "tool-error", "tool-unknown"],
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("does not sample lifecycle events", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-")),
      );
      const filePath = NodePath.join(tempDir, "canonical.log");
      try {
        const logger = yield* makeEventNdjsonLogger(filePath, {
          stream: "canonical",
          batchWindowMs: 0,
        });
        assert.exists(logger);
        if (!logger) return;
        for (let index = 0; index < 300; index += 1) {
          yield* logger.write(
            { type: "turn.completed", eventId: `completed-${index}`, payload: {} },
            ThreadId.make("thread-lifecycle"),
          );
        }
        yield* logger.close();
        assert.equal(readLines(filePath).length, 300);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("keeps native and canonical rotation files distinct and bounded", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-")),
      );
      const nativePath = NodePath.join(tempDir, "native.log");
      const canonicalPath = NodePath.join(tempDir, "canonical.log");
      try {
        const native = yield* makeEventNdjsonLogger(nativePath, {
          stream: "native",
          maxBytes: 500,
          maxFiles: 2,
          batchWindowMs: 0,
        });
        const canonical = yield* makeEventNdjsonLogger(canonicalPath, {
          stream: "canonical",
          maxBytes: 500,
          maxFiles: 2,
          batchWindowMs: 0,
        });
        assert.exists(native);
        assert.exists(canonical);
        if (!native || !canonical) return;

        for (let index = 0; index < 50; index += 1) {
          yield* native.write(
            { method: "turn/completed", id: `native-${index}`, payload: {} },
            ThreadId.make("thread-rotate"),
          );
          yield* canonical.write(
            { type: "turn.completed", eventId: `canonical-${index}`, payload: {} },
            ThreadId.make("thread-rotate"),
          );
        }
        yield* native.close();
        yield* canonical.close();

        const entries = NodeFS.readdirSync(tempDir);
        const nativeFiles = entries.filter((entry) => entry.startsWith("native.log"));
        const canonicalFiles = entries.filter((entry) => entry.startsWith("canonical.log"));
        assert.isAtMost(nativeFiles.length, 3);
        assert.isAtMost(canonicalFiles.length, 3);
        assert.isTrue(nativeFiles.length > 1);
        assert.isTrue(canonicalFiles.length > 1);
        assert.isFalse(entries.some((entry) => entry.startsWith("thread-rotate")));
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("keeps shared store views non-owning when one adapter closes", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-")),
      );
      const filePath = NodePath.join(tempDir, "events.log");

      try {
        const store = yield* makeEventNdjsonLogStore(filePath, { batchWindowMs: 0 });
        const native = store.logger("native");
        const canonical = store.logger("canonical");
        const threadId = ThreadId.make("thread-shared-close");

        yield* native.write({ id: "before-close" }, threadId);
        yield* native.close();
        yield* canonical.write({ type: "item.completed", eventId: "after-close" }, threadId);
        yield* store.close();

        assert.deepEqual(
          readLines(filePath).map((line) => {
            const payload = parsePayload(line);
            return { stream: payload.stream, id: (payload.event as { id?: string }).id };
          }),
          [
            { stream: "native", id: "before-close" },
            { stream: "canonical", id: "after-close" },
          ],
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("does not strand a later batch after an interrupted write", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-")),
      );
      const filePath = NodePath.join(tempDir, "native.log");
      const threadId = ThreadId.make("thread-interrupted");

      try {
        const logger = yield* makeEventNdjsonLogger(filePath, {
          stream: "native",
          batchWindowMs: 1_000,
        });
        assert.exists(logger);
        if (!logger) return;
        const interruptedWrite = yield* logger
          .write({ id: "possibly-interrupted" }, threadId)
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(interruptedWrite);
        yield* logger.write({ id: "accepted" }, threadId);

        yield* TestClock.adjust(1_000);
        yield* logger.close();

        assert.include(readEventIds(filePath), "accepted");
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("enforces aggregate age and byte retention on startup", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-")),
      );
      const filePath = NodePath.join(tempDir, "native.log");
      const expiredPath = `${filePath}.3`;
      const oldPath = `${filePath}.2`;
      const newPath = `${filePath}.1`;
      // Thread-scoped files from before the global streams are recognized by their line header.
      const legacyLogPath = NodePath.join(tempDir, "events.thread-1.log");
      const unrelatedLogPath = NodePath.join(tempDir, "unrelated.log");
      const ignoredPath = NodePath.join(tempDir, "ignored.txt");

      try {
        yield* TestClock.setTime(1_800_000_000_000);
        const now = yield* Clock.currentTimeMillis;
        for (const path of [expiredPath, oldPath, newPath, unrelatedLogPath, ignoredPath]) {
          NodeFS.writeFileSync(path, "x".repeat(40));
        }
        NodeFS.writeFileSync(legacyLogPath, "[2026-01-01T00:00:00.000Z] NTIVE: {}\n");
        for (const [path, ageMs] of [
          [expiredPath, 20_000],
          [legacyLogPath, 20_000],
          [oldPath, 5_000],
          [newPath, 0],
        ] as const) {
          NodeFS.utimesSync(path, (now - ageMs) / 1_000, (now - ageMs) / 1_000);
        }

        // A roomy byte budget isolates age retention.
        const ageStore = yield* makeEventNdjsonLogStore(filePath, { maxAgeMs: 10_000 });
        yield* ageStore.close();
        assert.isFalse(NodeFS.existsSync(expiredPath));
        assert.isFalse(NodeFS.existsSync(legacyLogPath));
        assert.isTrue(NodeFS.existsSync(oldPath));
        assert.isTrue(NodeFS.existsSync(newPath));

        // The byte budget then removes the oldest remaining provider files first.
        const byteStore = yield* makeEventNdjsonLogStore(filePath, {
          maxAgeMs: 10_000,
          maxTotalBytes: 60,
        });
        yield* byteStore.close();
        assert.isFalse(NodeFS.existsSync(oldPath));
        assert.isTrue(NodeFS.existsSync(newPath));
        assert.isTrue(NodeFS.existsSync(unrelatedLogPath));
        assert.isTrue(NodeFS.existsSync(ignoredPath));
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("does not prune the active stream file during a later flush", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-")),
      );
      const filePath = NodePath.join(tempDir, "native.log");

      try {
        const logger = yield* makeEventNdjsonLogger(filePath, {
          stream: "native",
          batchWindowMs: 0,
          maxAgeMs: 1,
          retentionCheckIntervalMs: 1,
        });
        assert.exists(logger);
        if (!logger) return;

        yield* logger.write({ id: "active-before-retention" }, ThreadId.make("active"));
        // Age the file far past maxAgeMs so only active-file protection can keep it.
        yield* TestClock.setTime(NodeFS.statSync(filePath).mtimeMs + 24 * 60 * 60 * 1_000);
        yield* logger.write({ id: "retention-trigger" }, ThreadId.make("other"));

        assert.deepEqual(readEventIds(filePath), ["active-before-retention", "retention-trigger"]);
        yield* logger.close();
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("attributes batches that were written before a later chunk fails", () =>
    Effect.gen(function* () {
      const records: ReadonlyArray<PendingRecord> = [
        { stream: "native", threadSegment: "_global", line: "first", bytes: 5 },
        { stream: "canonical", threadSegment: "_global", line: "second", bytes: 6 },
      ];
      const attributed: Array<PendingRecord> = [];
      let writes = 0;

      const result = yield* writeBatchedMessages(
        {
          write: () => {
            writes += 1;
            return writes === 2
              ? Effect.fail(
                  new RotatingFileSinkError({
                    operation: "write",
                    filePath: "test.log",
                    cause: "simulated disk exhaustion",
                  }),
                )
              : Effect.void;
          },
        },
        records,
        5,
        (written) => attributed.push(...written),
      ).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.deepEqual(attributed, [records[0]]);
    }),
  );

  it.effect(
    "keeps unrelated work responsive and drains before close while a disk write is held",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.realpathSync(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-")),
        );
        const filePath = NodePath.join(tempDir, "events.log");
        const fs = yield* FileSystem.FileSystem;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let writes = 0;
        try {
          const store = yield* makeEventNdjsonLogStore(filePath, { batchWindowMs: 0 }).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              writeFile: (path, content, options) =>
                Effect.gen(function* () {
                  if (++writes === 1) {
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(release);
                  }
                  yield* fs.writeFile(path, content, options);
                }),
            }),
          );
          const first = yield* store
            .logger("native")
            .write({ id: "first" }, ThreadId.make("held"))
            .pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const closed = yield* Deferred.make<void>();
          const close = yield* store
            .close()
            .pipe(Effect.andThen(Deferred.succeed(closed, undefined)), Effect.forkChild);
          assert.equal(yield* Deferred.isDone(closed), false);

          const heartbeat = yield* Deferred.make<void>();
          yield* Effect.forkChild(Deferred.succeed(heartbeat, undefined));
          yield* Deferred.await(heartbeat);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(close);
          assert.deepEqual(readEventIds(filePath), ["first"]);
        } finally {
          NodeFS.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
  );
});
