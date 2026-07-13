// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import {
  CommandId,
  defaultInstanceIdForDriver,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { TurnProcessingQuiescedReceipt } from "../src/orchestration/Services/RuntimeReceiptBus.ts";
import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import {
  makeEnergyAmplificationFixture,
  type EnergyAmplificationTerminalState,
} from "./fixtures/energyAmplification.ts";
import { readWorkloadDiagnosticsSnapshot } from "../src/diagnostics/WorkloadDiagnostics.ts";

const PROJECT_ID = ProjectId.make("energy-amplification-project");
const THREAD_ID = ThreadId.make("energy-amplification-thread");
const TURN_ID = TurnId.make("energy-amplification-turn");
const SUBAGENT_PROVIDER_THREAD_ID = "provider-energy-subagent";
const FIXTURE_TIME = "2026-07-10T15:10:34.000Z";

export interface EnergyAmplificationScenarioOptions {
  readonly providerChunkCount?: number;
  readonly commandOutputBytes?: number;
  readonly terminalState?: EnergyAmplificationTerminalState;
}

export interface EnergyAmplificationMetrics {
  readonly schemaVersion: 1;
  readonly fixture: {
    readonly providerChunkCount: number;
    readonly commandOutputBytes: number;
    readonly commandOutputSha256: string;
    readonly terminalState: EnergyAmplificationTerminalState;
  };
  readonly correctness: {
    readonly finalTranscriptBytes: number;
    readonly finalTranscriptSha256: string;
    readonly replayHash: string;
    readonly replayHashAfterReconnect: string;
    readonly transcriptSha256AfterReconnect: string;
    readonly replayExact: boolean;
    readonly sessionStatus: string | null;
    readonly latestTurnState: string | null;
    readonly latestTurnStateAfterReconnect: string | null;
  };
  readonly durable: {
    readonly eventCount: number;
    readonly eventTypeCounts: Readonly<Record<string, number>>;
    readonly eventPayloadBytes: number;
    readonly receiptCount: number;
  };
  readonly projection: {
    readonly reducerInputCount: number;
    readonly threadRows: number;
    readonly messageRows: number;
    readonly activityRows: number;
    readonly projectedActivityEventCount: number;
    readonly lastAppliedSequence: number;
  };
  readonly workload: {
    readonly counters: Readonly<Record<string, number>>;
    readonly gaugesBefore: Readonly<Record<string, number>>;
    readonly gaugesAfter: Readonly<Record<string, number>>;
  };
  readonly database: {
    readonly initialBytesAfterCheckpoint: number;
    readonly finalBytesAfterCheckpoint: number;
    readonly growthBytesAfterCheckpoint: number;
    readonly sqliteBytes: number;
    readonly walBytes: number;
    readonly shmBytes: number;
  };
  readonly elapsedMs: number;
}

interface DatabaseSnapshot {
  readonly eventCount: number;
  readonly maxSequence: number;
  readonly eventPayloadBytes: number;
  readonly receiptCount: number;
  readonly lastAppliedSequence: number;
  readonly threadRows: number;
  readonly messageRows: number;
  readonly activityRows: number;
  readonly eventTypeCounts: Readonly<Record<string, number>>;
  readonly sqliteBytes: number;
  readonly walBytes: number;
  readonly shmBytes: number;
  readonly totalBytes: number;
}

function fileSize(path: string): number {
  try {
    return NodeFS.statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function scalar(database: NodeSqlite.DatabaseSync, sql: string): number {
  const row = database.prepare(sql).get() as Record<string, unknown> | undefined;
  const value = row?.value;
  return typeof value === "number" ? value : Number(value ?? 0);
}

function readDatabaseSnapshot(dbPath: string): DatabaseSnapshot {
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const eventTypeRows = database
      .prepare(
        `SELECT event_type AS eventType, COUNT(*) AS count
         FROM orchestration_events
         GROUP BY event_type
         ORDER BY event_type`,
      )
      .all() as unknown as ReadonlyArray<{
      readonly eventType: string;
      readonly count: number;
    }>;
    const eventTypeCounts = Object.fromEntries(
      eventTypeRows.map((row) => [row.eventType, Number(row.count)]),
    );
    const sqliteBytes = fileSize(dbPath);
    const walBytes = fileSize(`${dbPath}-wal`);
    const shmBytes = fileSize(`${dbPath}-shm`);

    return {
      eventCount: scalar(database, "SELECT COUNT(*) AS value FROM orchestration_events"),
      maxSequence: scalar(
        database,
        "SELECT COALESCE(MAX(sequence), 0) AS value FROM orchestration_events",
      ),
      eventPayloadBytes: scalar(
        database,
        "SELECT COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS value FROM orchestration_events",
      ),
      receiptCount: scalar(
        database,
        "SELECT COUNT(*) AS value FROM orchestration_command_receipts",
      ),
      lastAppliedSequence: scalar(
        database,
        "SELECT COALESCE(MAX(last_applied_sequence), 0) AS value FROM projection_state",
      ),
      threadRows: scalar(database, "SELECT COUNT(*) AS value FROM projection_threads"),
      messageRows: scalar(database, "SELECT COUNT(*) AS value FROM projection_thread_messages"),
      activityRows: scalar(database, "SELECT COUNT(*) AS value FROM projection_thread_activities"),
      eventTypeCounts,
      sqliteBytes,
      walBytes,
      shmBytes,
      totalBytes: sqliteBytes + walBytes + shmBytes,
    };
  } finally {
    database.close();
  }
}

function sha256Strings(values: Iterable<string>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const value of values) {
    hash.update(value, "utf8");
  }
  return hash.digest("hex");
}

function replayHash(events: ReadonlyArray<OrchestrationEvent>): string {
  const hash = NodeCrypto.createHash("sha256");
  for (const event of events) {
    hash.update(event.type);
    hash.update("\0");
    hash.update(event.occurredAt);
    hash.update("\0");
    hash.update(JSON.stringify(event.payload));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function subagentTranscript(activity: OrchestrationThreadActivity | undefined): string {
  if (activity?.kind !== "subagent.thread") {
    return "";
  }
  const payload = activity.payload;
  if (payload === null || typeof payload !== "object") {
    return "";
  }
  const transcript = (payload as Record<string, unknown>).transcript;
  return typeof transcript === "string" ? transcript : "";
}

const seedProjectAndThread = Effect.fn("seedEnergyAmplificationProjectAndThread")(function* (
  harness: OrchestrationIntegrationHarness,
) {
  const provider = harness.adapterHarness!.provider;
  const instanceId = defaultInstanceIdForDriver(provider);
  const model = DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
  yield* harness.engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("energy-project-create"),
    projectId: PROJECT_ID,
    title: "Energy amplification benchmark",
    workspaceRoot: harness.workspaceDir,
    defaultModelSelection: { instanceId, model },
    createdAt: FIXTURE_TIME,
  });
  yield* harness.engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("energy-thread-create"),
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Pathological command-output session",
    modelSelection: { instanceId, model },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: harness.workspaceDir,
    createdAt: FIXTURE_TIME,
  });
});

function subtractTypeCounts(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.keys(after)
      .sort()
      .flatMap((eventType) => {
        const count = (after[eventType] ?? 0) - (before[eventType] ?? 0);
        return count > 0 ? [[eventType, count] as const] : [];
      }),
  );
}

function subtractNumericRecords(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Object.keys(after)
      .sort()
      .map((key) => [key, Math.max(0, (after[key] ?? 0) - (before[key] ?? 0))]),
  );
}

export const runEnergyAmplificationScenario = Effect.fn("runEnergyAmplificationScenario")(
  function* (options: EnergyAmplificationScenarioOptions = {}) {
    const harness = yield* makeOrchestrationIntegrationHarness();
    const run = Effect.gen(function* () {
      yield* seedProjectAndThread(harness);
      const initialDatabase = yield* Effect.sync(() => readDatabaseSnapshot(harness.dbPath));
      const initialWorkload = readWorkloadDiagnosticsSnapshot();
      const fixture = makeEnergyAmplificationFixture({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        providerThreadId: SUBAGENT_PROVIDER_THREAD_ID,
        ...(options.providerChunkCount !== undefined
          ? { providerChunkCount: options.providerChunkCount }
          : {}),
        ...(options.commandOutputBytes !== undefined
          ? { commandOutputBytes: options.commandOutputBytes }
          : {}),
        ...(options.terminalState !== undefined ? { terminalState: options.terminalState } : {}),
      });

      yield* harness.adapterHarness!.queueTurnResponseForNextSession(fixture.response);
      const startedAt = performance.now();
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`energy-turn-start-${fixture.terminalState}`),
        threadId: THREAD_ID,
        message: {
          messageId: MessageId.make(`energy-user-message-${fixture.terminalState}`),
          role: "user",
          text: "Run the deterministic command-output stress fixture.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: FIXTURE_TIME,
      });

      const expectedSessionStatus = fixture.terminalState === "completed" ? "ready" : "interrupted";
      const expectedTurnState = fixture.terminalState === "completed" ? "completed" : "interrupted";
      const expectedSubagentStatus = fixture.terminalState === "completed" ? "completed" : "failed";
      const thread = yield* harness.waitForThread(
        THREAD_ID,
        (candidate) =>
          candidate.session?.status === expectedSessionStatus &&
          candidate.latestTurn?.state === expectedTurnState &&
          candidate.activities.some((activity) => {
            if (activity.kind !== "subagent.thread") return false;
            const payload = activity.payload as Record<string, unknown>;
            return (
              payload.providerThreadId === SUBAGENT_PROVIDER_THREAD_ID &&
              payload.status === expectedSubagentStatus
            );
          }),
        15 * 60_000,
      );
      yield* harness.waitForReceipt(
        (receipt): receipt is TurnProcessingQuiescedReceipt =>
          receipt.type === "turn.processing.quiesced" && receipt.threadId === THREAD_ID,
        15 * 60_000,
      );
      const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
      const finalWorkload = readWorkloadDiagnosticsSnapshot();

      const firstReplay = yield* Stream.runCollect(
        harness.engine.readEvents(initialDatabase.maxSequence),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      const firstReplayHash = replayHash(firstReplay);
      const activity = thread.activities.find((candidate) => {
        if (candidate.kind !== "subagent.thread") return false;
        const payload = candidate.payload as Record<string, unknown>;
        return payload.providerThreadId === SUBAGENT_PROVIDER_THREAD_ID;
      });
      const transcript = subagentTranscript(activity);

      yield* harness.dispose;
      const reconnectHarness = yield* makeOrchestrationIntegrationHarness({
        rootDir: harness.rootDir,
      });
      const reconnectedThread = yield* reconnectHarness.waitForThread(THREAD_ID, (candidate) =>
        candidate.activities.some(
          (candidateActivity) =>
            candidateActivity.kind === "subagent.thread" &&
            subagentTranscript(candidateActivity) === fixture.finalTranscript,
        ),
      );
      const secondReplay = yield* Stream.runCollect(
        reconnectHarness.engine.readEvents(initialDatabase.maxSequence, firstReplay.length),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      const secondReplayHash = replayHash(secondReplay);
      const reconnectedActivity = reconnectedThread.activities.find((candidate) => {
        if (candidate.kind !== "subagent.thread") return false;
        const payload = candidate.payload as Record<string, unknown>;
        return payload.providerThreadId === SUBAGENT_PROVIDER_THREAD_ID;
      });
      const reconnectedTranscript = subagentTranscript(reconnectedActivity);
      yield* reconnectHarness.dispose;
      const finalDatabase = yield* Effect.sync(() => readDatabaseSnapshot(harness.dbPath));
      const eventTypeCounts = subtractTypeCounts(
        initialDatabase.eventTypeCounts,
        finalDatabase.eventTypeCounts,
      );
      const durableEventCount = finalDatabase.eventCount - initialDatabase.eventCount;
      const projectedActivityEventCount = eventTypeCounts["thread.activity-appended"] ?? 0;

      return {
        schemaVersion: 1,
        fixture: {
          providerChunkCount: fixture.providerChunkCount,
          commandOutputBytes: fixture.commandOutputBytes,
          commandOutputSha256: sha256Strings(fixture.providerChunks),
          terminalState: fixture.terminalState,
        },
        correctness: {
          finalTranscriptBytes: Buffer.byteLength(transcript, "utf8"),
          finalTranscriptSha256: sha256Strings([transcript]),
          replayHash: firstReplayHash,
          replayHashAfterReconnect: secondReplayHash,
          transcriptSha256AfterReconnect: sha256Strings([reconnectedTranscript]),
          replayExact: firstReplayHash === secondReplayHash && transcript === reconnectedTranscript,
          sessionStatus: thread.session?.status ?? null,
          latestTurnState: thread.latestTurn?.state ?? null,
          latestTurnStateAfterReconnect: reconnectedThread.latestTurn?.state ?? null,
        },
        durable: {
          eventCount: durableEventCount,
          eventTypeCounts,
          eventPayloadBytes: finalDatabase.eventPayloadBytes - initialDatabase.eventPayloadBytes,
          receiptCount: finalDatabase.receiptCount - initialDatabase.receiptCount,
        },
        projection: {
          reducerInputCount:
            finalDatabase.lastAppliedSequence - initialDatabase.lastAppliedSequence,
          threadRows: finalDatabase.threadRows,
          messageRows: finalDatabase.messageRows,
          activityRows: finalDatabase.activityRows,
          projectedActivityEventCount,
          lastAppliedSequence: finalDatabase.lastAppliedSequence,
        },
        workload: {
          counters: subtractNumericRecords(initialWorkload.counters, finalWorkload.counters),
          gaugesBefore: initialWorkload.gauges,
          gaugesAfter: finalWorkload.gauges,
        },
        database: {
          initialBytesAfterCheckpoint: initialDatabase.totalBytes,
          finalBytesAfterCheckpoint: finalDatabase.totalBytes,
          growthBytesAfterCheckpoint: finalDatabase.totalBytes - initialDatabase.totalBytes,
          sqliteBytes: finalDatabase.sqliteBytes,
          walBytes: finalDatabase.walBytes,
          shmBytes: finalDatabase.shmBytes,
        },
        elapsedMs,
      } satisfies EnergyAmplificationMetrics;
    });

    return yield* run.pipe(Effect.ensuring(harness.dispose));
  },
);
