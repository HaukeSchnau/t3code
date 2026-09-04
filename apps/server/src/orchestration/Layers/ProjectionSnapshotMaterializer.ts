import type {
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadActivityDetailMode,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { ProjectionSnapshotMaterializer } from "../Services/ProjectionSnapshotMaterializer.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

type FlightMap<A> = Map<string, Deferred.Deferred<A, ProjectionRepositoryError>>;

interface FlightSelection<A> {
  readonly deferred: Deferred.Deferred<A, ProjectionRepositoryError>;
  readonly leader: boolean;
}

type FlightSelectionResult<A> = readonly [FlightSelection<A>, FlightMap<A>];

export interface ProjectionSnapshotFlightObservation {
  readonly key: string;
  readonly leader: boolean;
}

export const makeProjectionSnapshotMaterializer = Effect.fn("makeProjectionSnapshotMaterializer")(
  function* (
    observeFlight?: (observation: ProjectionSnapshotFlightObservation) => Effect.Effect<void>,
  ) {
    const query = yield* ProjectionSnapshotQuery;
    const loaderScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const fullFlights = yield* SynchronizedRef.make<FlightMap<OrchestrationReadModel>>(new Map());
    const shellFlights = yield* SynchronizedRef.make<FlightMap<OrchestrationShellSnapshot>>(
      new Map(),
    );
    const threadFlights = yield* SynchronizedRef.make<
      FlightMap<Option.Option<OrchestrationThreadDetailSnapshot>>
    >(new Map());

    const singleFlight = Effect.fn("ProjectionSnapshotMaterializer.singleFlight")(function* <A>(
      flights: SynchronizedRef.SynchronizedRef<FlightMap<A>>,
      key: string,
      load: Effect.Effect<A, ProjectionRepositoryError>,
    ) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const selected = yield* SynchronizedRef.modifyEffect(
            flights,
            (current): Effect.Effect<FlightSelectionResult<A>> => {
              const active = current.get(key);
              if (active !== undefined) {
                return Effect.succeed([{ deferred: active, leader: false }, current] as const);
              }
              return Deferred.make<A, ProjectionRepositoryError>().pipe(
                Effect.map((deferred) => {
                  const next = new Map(current);
                  next.set(key, deferred);
                  return [{ deferred, leader: true }, next] as const;
                }),
              );
            },
          );

          if (observeFlight !== undefined) {
            yield* observeFlight({ key, leader: selected.leader });
          }

          if (selected.leader) {
            const finish = (exit: Exit.Exit<A, ProjectionRepositoryError>) =>
              SynchronizedRef.modify(flights, (current) => {
                if (current.get(key) !== selected.deferred) return [undefined, current] as const;
                const next = new Map(current);
                next.delete(key);
                return [undefined, next] as const;
              }).pipe(Effect.andThen(Deferred.done(selected.deferred, exit)));

            yield* restore(load).pipe(
              Effect.onExit(finish),
              Effect.forkIn(loaderScope, { startImmediately: true }),
            );
          }

          return yield* restore(Deferred.await(selected.deferred));
        }),
      );
    });

    const snapshotSequence = Effect.fn("ProjectionSnapshotMaterializer.snapshotSequence")(
      function* () {
        return (yield* query.getSnapshotSequence()).snapshotSequence;
      },
    );

    return ProjectionSnapshotMaterializer.of({
      getSnapshot: Effect.fn("ProjectionSnapshotMaterializer.getSnapshot")(function* () {
        const sequence = yield* snapshotSequence();
        return yield* singleFlight(fullFlights, `full:${sequence}`, query.getSnapshot());
      }),
      getShellSnapshot: Effect.fn("ProjectionSnapshotMaterializer.getShellSnapshot")(function* () {
        const sequence = yield* snapshotSequence();
        return yield* singleFlight(shellFlights, `shell:${sequence}`, query.getShellSnapshot());
      }),
      getThreadDetailSnapshot: Effect.fn("ProjectionSnapshotMaterializer.getThreadDetailSnapshot")(
        function* (
          threadId,
          activityDetailMode: OrchestrationThreadActivityDetailMode = "full",
          window,
        ) {
          const sequence = yield* snapshotSequence();
          return yield* singleFlight(
            threadFlights,
            `thread:${threadId}:${activityDetailMode}:${window?.turnLimit ?? "all"}:${window?.beforeCursor ?? "latest"}:${sequence}`,
            query.getThreadDetailSnapshot(threadId, activityDetailMode, window),
          );
        },
      ),
    });
  },
);

export const OrchestrationProjectionSnapshotMaterializerLive = Layer.effect(
  ProjectionSnapshotMaterializer,
  makeProjectionSnapshotMaterializer(),
);
