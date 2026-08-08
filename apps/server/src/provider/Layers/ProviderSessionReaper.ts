import { CommandId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { recordRuntimeReconciliationMetric } from "../../observability/Metrics.ts";
import {
  decideProviderSessionReconciliation,
  SERVER_RUNTIME_STARTED_AT,
} from "../ProviderSessionReconciliation.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { forkParked } from "../../serverActivation.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  readonly runtimeStartedAt?: string;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const runtimeStartedAt = options?.runtimeStartedAt ?? SERVER_RUNTIME_STARTED_AT;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const reconcileStartupProjections = Effect.fn(
      "ProviderSessionReaper.reconcileStartupProjections",
    )(function* () {
      if (projectionSnapshotQuery.getRestartSafetyState === undefined) {
        yield* Effect.logWarning("provider.session.reconciliation.unavailable", {
          reason: "restart-safety-query-unavailable",
        });
        return;
      }

      const [projectedState, liveSessions] = yield* Effect.all([
        projectionSnapshotQuery.getRestartSafetyState(),
        providerService.listSessions(),
      ]);
      const liveByThreadId = new Map(liveSessions.map((session) => [session.threadId, session]));

      for (const projected of projectedState.threads) {
        const decision = decideProviderSessionReconciliation({
          projected,
          liveSession: liveByThreadId.get(projected.threadId),
          runtimeStartedAt,
        });
        yield* recordRuntimeReconciliationMetric({
          action: "examined",
          reason: "candidate",
          outcome: "success",
        });

        if (decision._tag === "Skip") {
          yield* recordRuntimeReconciliationMetric({
            action: "skipped",
            reason: decision.reason,
            outcome: "success",
          });
          yield* Effect.logDebug("provider.session.reconciliation.skipped", {
            threadId: projected.threadId,
            reason: decision.reason,
            runtimeStartedAt,
            projectedSessionUpdatedAt: projected.session?.updatedAt,
            projectedTurnId: projected.session?.activeTurnId,
            liveTurnId: liveByThreadId.get(projected.threadId)?.activeTurnId,
            undeliveredTranscriptEventCount: projected.undeliveredTranscriptEventCount,
          });
          continue;
        }

        const repair =
          decision.repair._tag === "InterruptTurn"
            ? orchestrationEngine.dispatch({
                type: "thread.turn.interrupt",
                commandId: CommandId.make(
                  `provider:startup-reconcile:${runtimeStartedAt}:${projected.threadId}:${decision.repair.turnId}:interrupt-turn`,
                ),
                threadId: projected.threadId,
                turnId: decision.repair.turnId,
                createdAt: runtimeStartedAt,
              })
            : orchestrationEngine.dispatch({
                type: "thread.session.set",
                commandId: CommandId.make(
                  `provider:startup-reconcile:${runtimeStartedAt}:${projected.threadId}:${decision.repair.session.activeTurnId ?? "no-turn"}:set-session-${decision.repair.status}`,
                ),
                threadId: projected.threadId,
                session: {
                  ...decision.repair.session,
                  status: decision.repair.status,
                  activeTurnId: null,
                  updatedAt: runtimeStartedAt,
                },
                createdAt: runtimeStartedAt,
              });

        yield* repair.pipe(
          Effect.tap(() =>
            recordRuntimeReconciliationMetric({
              action: "repaired",
              reason: decision.reason,
              outcome: "success",
            }),
          ),
          Effect.tap(() =>
            Effect.logInfo("provider.session.reconciliation.repaired", {
              threadId: projected.threadId,
              reason: decision.reason,
              repairKind: decision.repair._tag,
              previousStatus: projected.session?.status,
              repairedStatus:
                decision.repair._tag === "SetSession" ? decision.repair.status : "interrupted",
              projectedTurnId: projected.session?.activeTurnId ?? projected.latestTurnId,
              projectedAgeMs:
                projected.session === null
                  ? undefined
                  : Math.max(
                      0,
                      Date.parse(runtimeStartedAt) - Date.parse(projected.session.updatedAt),
                    ),
              runtimeStartedAt,
            }),
          ),
          Effect.catchCause((cause) =>
            recordRuntimeReconciliationMetric({
              action: "error",
              reason: "repair_failed",
              outcome: "failure",
            }).pipe(
              Effect.andThen(
                Effect.logWarning("provider.session.reconciliation.repair-failed", {
                  threadId: projected.threadId,
                  reason: decision.reason,
                  cause,
                }),
              ),
            ),
          ),
        );
      }
    });

    const reconcileSafely = reconcileStartupProjections().pipe(
      Effect.catchCause((cause) =>
        recordRuntimeReconciliationMetric({
          action: "error",
          reason: "unknown",
          outcome: "failure",
        }).pipe(
          Effect.andThen(Effect.logWarning("provider.session.reconciliation.failed", { cause })),
        ),
      ),
    );

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        // The turn can settle while background work runs on (subagent
        // fleets, workflow runs, Monitor watch loops). Those live inside the
        // provider process, so stopping the session would kill them silently,
        // and nothing bumps lastSeenAt between turns.
        if (thread?.backgroundLiveness != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-background-work", {
            threadId: binding.threadId,
            backgroundLiveness: thread.backgroundLiveness,
            idleDurationMs,
          });
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* reconcileSafely;
        yield* forkParked(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );
        yield* Effect.forkScoped(
          Effect.sleep(Duration.millis(sweepIntervalMs)).pipe(
            Effect.andThen(reconcileSafely),
            Effect.forever,
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
