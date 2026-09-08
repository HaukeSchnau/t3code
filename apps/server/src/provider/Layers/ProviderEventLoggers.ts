/**
 * ProviderEventLoggers — single observability service that owns the two
 * global provider event log streams:
 *
 *   - `native`    — provider-protocol events as the SDK emits them, written
 *                   from inside each `<X>Adapter` factory.
 *   - `canonical` — runtime events after `ProviderService` has normalized
 *                   them onto `ProviderRuntimeEvent`.
 *
 * Why a service tag and not constructor options?
 *
 *   - Adapters are now constructed *inside* drivers (`<X>Driver.create()`),
 *     not at the boot Layer. There is no longer a single `make<X>AdapterLive(options)`
 *     call site where we can hand an `EventNdjsonLogger` in by hand.
 *   - Multiple driver instances per kind (`codex_personal`, `codex_work`)
 *     must share one writer per stream. Owning the loggers on a single tag
 *     keeps that invariant intact.
 *   - Tests can swap one (or both) loggers with in-memory recorders by
 *     `Layer.succeed(ProviderEventLoggers, { native, canonical })` instead of
 *     juggling per-Layer option threading.
 *
 * Both fields are optional because observability must not prevent startup.
 *
 * @module provider/Layers/ProviderEventLoggers
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import * as EventNdjsonLogger from "./EventNdjsonLogger.ts";

/**
 * Shared logger pair for native + canonical provider event streams.
 *
 * Service value is intentionally a struct of two optional loggers rather
 * than two parallel tags. Construction site is one place
 * (`layer`); consumers (drivers, `ProviderService`) read one tag and pluck the
 * field they need.
 */
export class ProviderEventLoggers extends Context.Service<
  ProviderEventLoggers,
  {
    readonly native: EventNdjsonLogger.EventNdjsonLogger | undefined;
    readonly canonical: EventNdjsonLogger.EventNdjsonLogger | undefined;
  }
>()("t3/provider/Layers/ProviderEventLoggers") {}

/**
 * Constant value used by tests / boot layers that want to opt out of native
 * + canonical logging entirely. Keeps the tag non-optional in the type
 * system while letting the runtime treat absence as a no-op.
 */
export const NoOpProviderEventLoggers: ProviderEventLoggers["Service"] = {
  native: undefined,
  canonical: undefined,
};

/**
 * Builds one global logger for each stream. Setup failures are logged and
 * downgraded to a missing logger so diagnostics never block startup.
 *
 * @public Service construction is part of the canonical Effect module API.
 */
export const make = Effect.gen(function* () {
  const { providerLogsDir } = yield* ServerConfig;
  const attribution = yield* ResourceAttribution.ResourceAttribution;
  const path = yield* Path.Path;
  const native = yield* EventNdjsonLogger.makeEventNdjsonLogger(
    path.join(providerLogsDir, "native.log"),
    { stream: "native", attribution },
  );
  const canonical = yield* EventNdjsonLogger.makeEventNdjsonLogger(
    path.join(providerLogsDir, "canonical.log"),
    { stream: "canonical", attribution },
  );
  yield* Effect.addFinalizer(() =>
    Effect.all([native?.close() ?? Effect.void, canonical?.close() ?? Effect.void], {
      discard: true,
    }),
  );
  return ProviderEventLoggers.of({
    native,
    canonical,
  });
});

export const layer = Layer.effect(ProviderEventLoggers, make);
