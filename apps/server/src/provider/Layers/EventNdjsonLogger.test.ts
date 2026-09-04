// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

function parsePayload(line: string): Record<string, unknown> {
  const match = /^\[[^\]]+\] [A-Z]+: (.+)$/.exec(line);
  assert.notEqual(match, null);
  if (!match?.[1]) throw new Error(`invalid provider log line: ${line}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function readLines(filePath: string): ReadonlyArray<string> {
  return NodeFS.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
}

describe("EventNdjsonLogger", () => {
  it.effect("writes metadata-only records to the exact global stream path", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
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
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const filePath = NodePath.join(tempDir, "canonical.log");
      const secret = "secret-circular-value";
      const circular: Record<string, unknown> = { secret, delta: "x".repeat(2_000_000) };
      circular.self = circular;

      try {
        const logger = yield* makeEventNdjsonLogger(filePath, { stream: "canonical" });
        assert.exists(logger);
        if (!logger) return;
        yield* logger.write(
          { type: "content.delta", eventId: "evt-giant", payload: circular },
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

  it.effect("samples 9,200 high-frequency deltas deterministically", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const filePath = NodePath.join(tempDir, "canonical.log");

      try {
        const logger = yield* makeEventNdjsonLogger(filePath, {
          stream: "canonical",
          batchWindowMs: 0,
        });
        assert.exists(logger);
        if (!logger) return;
        for (let index = 0; index < 9_200; index += 1) {
          yield* logger.write(
            { type: "content.delta", payload: { delta: `chunk-${index}` } },
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

  it.effect("omits running OpenCode tool snapshots but keeps lifecycle states", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
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
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
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
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
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
});
