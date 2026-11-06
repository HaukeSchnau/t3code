import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";

export const EnvironmentMode = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  environmentIds: Schema.Array(EnvironmentId),
});
export type EnvironmentMode = typeof EnvironmentMode.Type;

/** A mode id, or `null` for the built-in mode that turns on everything any mode names. */
export type EnvironmentModeSelection = string | null;

/**
 * The switch each environment takes when `selection` applies. Environments that no mode names
 * keep their switch, so a newly added environment never disappears behind a mode.
 */
export function environmentModeTargets(
  modes: ReadonlyArray<EnvironmentMode>,
  selection: EnvironmentModeSelection,
  known: ReadonlyMap<EnvironmentId, unknown>,
): ReadonlyMap<EnvironmentId, boolean> {
  const selected = selection === null ? null : modes.find((mode) => mode.id === selection);
  if (selected === undefined) return new Map();
  const targets = new Map<EnvironmentId, boolean>();
  for (const mode of modes) {
    for (const environmentId of mode.environmentIds) {
      if (known.has(environmentId)) {
        targets.set(
          environmentId,
          selected === null || selected.environmentIds.includes(environmentId),
        );
      }
    }
  }
  return targets;
}

type EnvironmentSwitches = ReadonlyMap<EnvironmentId, { readonly enabled: boolean }>;

function isApplied(
  modes: ReadonlyArray<EnvironmentMode>,
  selection: EnvironmentModeSelection,
  entries: EnvironmentSwitches,
): boolean {
  return [...environmentModeTargets(modes, selection, entries)].every(
    ([environmentId, enabled]) => entries.get(environmentId)?.enabled === enabled,
  );
}

export function activeEnvironmentMode(
  modes: ReadonlyArray<EnvironmentMode>,
  entries: EnvironmentSwitches,
): EnvironmentModeSelection | "custom" {
  return (
    modes.find((mode) => isApplied(modes, mode.id, entries))?.id ??
    (isApplied(modes, null, entries) ? null : "custom")
  );
}

export function environmentModeLabel(
  modes: ReadonlyArray<EnvironmentMode>,
  selection: EnvironmentModeSelection | "custom",
): string {
  if (selection === "custom") return "Custom";
  return modes.find((mode) => mode.id === selection)?.name ?? "All environments";
}

/** The next mode in the cycle that changes a switch, so modes with identical sets never trap it. */
export function nextEnvironmentMode(
  modes: ReadonlyArray<EnvironmentMode>,
  entries: EnvironmentSwitches,
): EnvironmentModeSelection {
  const order: EnvironmentModeSelection[] = [...modes.map((mode) => mode.id), null];
  const active = activeEnvironmentMode(modes, entries);
  const index = active === "custom" ? -1 : order.indexOf(active);
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(index + step) % order.length]!;
    if (!isApplied(modes, candidate, entries)) return candidate;
  }
  return active === "custom" ? order[0]! : active;
}

export class EnvironmentModes extends Context.Reference<{
  readonly get: Effect.Effect<ReadonlyArray<EnvironmentMode>>;
  readonly changes: Stream.Stream<ReadonlyArray<EnvironmentMode>>;
  readonly update: (
    transform: (modes: ReadonlyArray<EnvironmentMode>) => ReadonlyArray<EnvironmentMode>,
  ) => Effect.Effect<void, ConnectionAttemptError>;
}>("@t3tools/client-runtime/connection/EnvironmentModes", {
  defaultValue: () => ({
    get: Effect.succeed([]),
    changes: Stream.succeed([]),
    update: () =>
      Effect.fail(
        new ConnectionBlockedError({
          reason: "unsupported",
          detail: "Environment modes are unavailable on this client.",
        }),
      ),
  }),
}) {}

export const makeEnvironmentModes = Effect.fn("makeEnvironmentModes")(function* (storage: {
  readonly read: Effect.Effect<ReadonlyArray<EnvironmentMode>, ConnectionAttemptError>;
  readonly write: (
    modes: ReadonlyArray<EnvironmentMode>,
  ) => Effect.Effect<void, ConnectionAttemptError>;
}) {
  const state = yield* SubscriptionRef.make<ReadonlyArray<EnvironmentMode>>([]);
  const lock = yield* Semaphore.make(1);
  // Loads on first use, so building the client runtime does no storage I/O. A failed load
  // reads as no modes and is retried next time; `update` fails instead of overwriting.
  const load = yield* Effect.cachedWithTTL(
    storage.read.pipe(Effect.flatMap((modes) => SubscriptionRef.set(state, modes))),
    (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  );
  const loaded = load.pipe(Effect.ignore, Effect.andThen(SubscriptionRef.get(state)));
  return EnvironmentModes.of({
    get: loaded,
    changes: Stream.unwrap(loaded.pipe(Effect.as(SubscriptionRef.changes(state)))),
    update: Effect.fn("EnvironmentModes.update")(function (transform) {
      return lock.withPermits(1)(
        Effect.gen(function* () {
          yield* load;
          const modes = transform(yield* SubscriptionRef.get(state));
          yield* storage.write(modes);
          yield* SubscriptionRef.set(state, modes);
        }),
      );
    }),
  });
});
