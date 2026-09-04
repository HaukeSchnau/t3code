// @effect-diagnostics nodeBuiltinImport:off
/**
 * Best-effort, metadata-only provider event logger.
 *
 * Each logger owns one globally rotated stream file. Provider payload values
 * are never persisted; high-frequency deltas are deterministically sampled.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ThreadId } from "@t3tools/contracts";
import { RotatingFileSink } from "@t3tools/shared/logging";
import { errorTag } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { incrementWorkloadCounter } from "../../diagnostics/WorkloadDiagnostics.ts";
import {
  isHighFrequencyProviderEvent,
  makeProviderEventMetadata,
  type ProviderEventMetadataRecord,
} from "./ProviderEventMetadata.ts";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
// RotatingFileSink retains the active file plus this many backups.
const DEFAULT_MAX_FILES = 2;
const DEFAULT_BATCH_WINDOW_MS = 200;
const MAX_METADATA_RECORD_BYTES = 1024;
const HIGH_FREQUENCY_FIRST_RECORDS = 8;
const HIGH_FREQUENCY_SAMPLE_INTERVAL = 256;
const HIGH_FREQUENCY_SAMPLE_KEY_CAPACITY = 2_048;
const LOG_SCOPE = "provider-observability";
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

export interface EventNdjsonLogger {
  readonly filePath: string;
  write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void, never, never>;
  close: () => Effect.Effect<void, never, never>;
}

export interface EventNdjsonLoggerOptions {
  readonly stream: EventNdjsonStream;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly batchWindowMs?: number;
}

interface SampleState {
  occurrence: number;
  lastEmitted: number;
}

function logWarning(message: string, context: Record<string, unknown>): Effect.Effect<void> {
  return Effect.logWarning(message, context).pipe(Effect.annotateLogs({ scope: LOG_SCOPE }));
}

function formatLoggerMessage(message: unknown): string {
  if (Array.isArray(message)) {
    return message.map((part) => (typeof part === "string" ? part : String(part))).join(" ");
  }
  return typeof message === "string" ? message : String(message);
}

function makeLineLogger(streamLabel: string): Logger.Logger<unknown, string> {
  return Logger.make(
    ({ date, message }) =>
      `[${date.toISOString()}] ${streamLabel}: ${formatLoggerMessage(message)}\n`,
  );
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  switch (stream) {
    case "native":
      return "NTIVE";
    case "canonical":
    case "orchestration":
    default:
      return "CANON";
  }
}

/** OpenCode republishes the full growing tool output for every running update. */
function isRunningOpenCodeToolSnapshot(event: unknown): boolean {
  if (typeof event !== "object" || event === null) return false;
  try {
    const nested = Reflect.get(event, "event");
    const nativeEvent = typeof nested === "object" && nested !== null ? nested : event;
    if (Reflect.get(nativeEvent, "type") !== "message.part.updated") return false;
    const payload = Reflect.get(nativeEvent, "payload");
    if (typeof payload !== "object" || payload === null) return false;
    const properties = Reflect.get(payload, "properties");
    if (typeof properties !== "object" || properties === null) return false;
    const part = Reflect.get(properties, "part");
    if (typeof part !== "object" || part === null || Reflect.get(part, "type") !== "tool") {
      return false;
    }
    const state = Reflect.get(part, "state");
    return (
      typeof state === "object" && state !== null && Reflect.get(state, "status") === "running"
    );
  } catch {
    return false;
  }
}

function fallbackMetadata(record: ProviderEventMetadataRecord): ProviderEventMetadataRecord {
  return {
    schemaVersion: 1,
    stream: record.stream,
    threadId: record.threadId,
    event: { name: record.event.name },
    body: { valueType: "missing" },
    ...(record.sampling ? { sampling: record.sampling } : {}),
    metadataTruncated: true,
  };
}

const toLogMessage = Effect.fn("toLogMessage")(function* (
  metadata: ProviderEventMetadataRecord,
): Effect.fn.Return<{ readonly message: string; readonly bytes: number } | undefined> {
  const encoded = yield* encodeUnknownJsonString(metadata).pipe(
    Effect.catch((error) =>
      logWarning("failed to serialize provider event metadata record", {
        errorTag: errorTag(error),
      }).pipe(Effect.as(undefined)),
    ),
  );
  if (!encoded) return undefined;

  const encodedBytes = Buffer.byteLength(encoded);
  if (encodedBytes <= MAX_METADATA_RECORD_BYTES) {
    return { message: encoded, bytes: encodedBytes };
  }

  const fallback = yield* encodeUnknownJsonString(fallbackMetadata(metadata)).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  return fallback === undefined
    ? undefined
    : { message: fallback, bytes: Buffer.byteLength(fallback) };
});

export const makeEventNdjsonLogger = Effect.fn("makeEventNdjsonLogger")(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonLogger | undefined> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const batchWindowMs = options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS;
  const streamLabel = resolveStreamLabel(options.stream);

  const directoryReady = yield* Effect.sync(() => {
    try {
      NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
      return true;
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  if (directoryReady !== true) {
    yield* logWarning("failed to create provider event log directory", {
      filePath,
      errorTag: errorTag(directoryReady.error),
    });
    return undefined;
  }

  const sinkResult = yield* Effect.sync(() => {
    try {
      return {
        ok: true as const,
        sink: new RotatingFileSink({ filePath, maxBytes, maxFiles, throwOnError: true }),
      };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  if (!sinkResult.ok) {
    yield* logWarning("failed to initialize provider event log file", {
      filePath,
      errorTag: errorTag(sinkResult.error),
    });
    return undefined;
  }

  const sink = sinkResult.sink;
  const scope = yield* Scope.make();
  const lineLogger = makeLineLogger(streamLabel);
  const batchedLogger = yield* Logger.batched(lineLogger, {
    window: batchWindowMs,
    flush: Effect.fn("makeEventNdjsonLogger.flush")(function* (messages) {
      const flushResult = yield* Effect.sync(() => {
        try {
          for (const message of messages) sink.write(message);
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, error };
        }
      });
      if (!flushResult.ok) {
        yield* logWarning("provider event log batch flush failed", {
          filePath,
          errorTag: errorTag(flushResult.error),
        });
      }
    }),
  }).pipe(Effect.provideService(Scope.Scope, scope));
  const loggerLayer = Logger.layer([batchedLogger], { mergeWithExisting: false });
  const sampleStates = new Map<string, SampleState>();

  function sampledMetadata(
    event: unknown,
    threadId: ThreadId | null,
  ): ProviderEventMetadataRecord | null {
    const base = makeProviderEventMetadata({
      event,
      stream: options.stream,
      threadId,
    });
    if (!isHighFrequencyProviderEvent(options.stream, base.event.name)) return base;

    const key = `${options.stream}\0${threadId ?? "_global"}\0${base.event.name}`;
    let state = sampleStates.get(key);
    if (!state) {
      if (sampleStates.size >= HIGH_FREQUENCY_SAMPLE_KEY_CAPACITY) {
        const oldest = sampleStates.keys().next().value;
        if (oldest !== undefined) sampleStates.delete(oldest);
      }
      state = { occurrence: 0, lastEmitted: 0 };
      sampleStates.set(key, state);
    }

    state.occurrence += 1;
    const shouldEmit =
      state.occurrence <= HIGH_FREQUENCY_FIRST_RECORDS ||
      state.occurrence % HIGH_FREQUENCY_SAMPLE_INTERVAL === 0;
    if (!shouldEmit) {
      incrementWorkloadCounter("provider_log.sampled_suppressed");
      return null;
    }

    const sampling = {
      occurrence: state.occurrence,
      suppressedSincePrevious: Math.max(0, state.occurrence - state.lastEmitted - 1),
    };
    state.lastEmitted = state.occurrence;
    return { ...base, sampling };
  }

  const write = Effect.fn("write")(function* (event: unknown, threadId: ThreadId | null) {
    incrementWorkloadCounter("provider_log.candidates");
    if (options.stream === "native" && isRunningOpenCodeToolSnapshot(event)) {
      incrementWorkloadCounter("provider_log.sampled_suppressed");
      return;
    }
    const metadata = sampledMetadata(event, threadId);
    if (!metadata) return;

    const encoded = yield* toLogMessage(metadata);
    if (!encoded) return;

    incrementWorkloadCounter("provider_log.records");
    incrementWorkloadCounter("provider_log.bytes", encoded.bytes);
    yield* Effect.log(encoded.message).pipe(Effect.provide(loggerLayer));
  });

  return {
    filePath,
    write,
    close: () => Scope.close(scope, Exit.void),
  } satisfies EventNdjsonLogger;
});
