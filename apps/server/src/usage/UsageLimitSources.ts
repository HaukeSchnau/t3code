import {
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ServerSettings,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  isUsageLimitsThrottled,
  resolveUsageLimitsAfterProbe,
  USAGE_LIMITS_MIN_READ_GAP_MS,
} from "@t3tools/provider-core/server/usageLimits";
import * as Settings from "../serverSettings.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    /**
     * Re-read every source, except one read in the last 30 seconds and
     * accounts still throttled. Never fails; failures land on the snapshot.
     */
    readonly refresh: Effect.Effect<void>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
  }
>()("t3/usage/UsageLimitSources") {}

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const settingsService = yield* Settings.ServerSettingsService;
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  /** `fresh` names an account to read even while its last read was throttled. */
  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
    fresh?: string,
  ) {
    const now = yield* DateTime.now;
    const checkedAt = DateTime.formatIso(now);
    const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt } as const;
    if (config.managementKey.length === 0) {
      return { ...base, accounts: [], error: "No management key configured." };
    }
    // A failed account read keeps its last good reading, because the providers rate-limit
    // their quota endpoints (patches/hub-account-last-reading.md). A throttled account is
    // not read again before the time the provider named (patches/usage-limits-refresh.md).
    const published = (yield* Ref.get(stateRef)).find((source) => source.id === id)?.accounts;
    const nowMs = DateTime.toEpochMillis(now);
    const accounts = yield* api
      .readAccounts(config, (accountId) => {
        const last = published?.find((candidate) => candidate.id === accountId);
        return last && accountId !== fresh && isUsageLimitsThrottled(last.usageLimits, nowMs)
          ? last
          : undefined;
      })
      .pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logWarning("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    return {
      ...base,
      accounts: accounts.success.map((account) => {
        const last = published?.find((candidate) => candidate.id === account.id);
        if (!last) return account;
        const usageLimits = resolveUsageLimitsAfterProbe({
          published: last.usageLimits,
          probed: account.usageLimits,
        });
        // The whole account, since a failed read also loses the plan.
        return !usageLimits || usageLimits === account.usageLimits
          ? account
          : { ...last, usageLimits };
      }),
    };
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    next: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  // One refresh at a time: a slow hub read started before a settings change
  // must not publish after the change's own refresh and resurrect a removed
  // source. Callers queue behind the in-flight run and see current settings,
  // and a caller that queued behind a read of a source reuses that read.
  const refreshLock = yield* Semaphore.make(1);
  const refreshSources = Effect.fn("UsageLimitSources.refreshSources")(
    function* (force: boolean) {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.orElseSucceed((): ServerSettings | null => null),
      );
      const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
        ([, config]) => config.enabled,
      );
      const published = yield* Ref.get(stateRef);
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const snapshots = yield* Effect.forEach(
        entries,
        ([id, config]): Effect.Effect<UsageLimitSourceSnapshot> => {
          const last = published.find((source) => source.id === id);
          return !force && last && nowMs - Date.parse(last.checkedAt) < USAGE_LIMITS_MIN_READ_GAP_MS
            ? Effect.succeed(last)
            : readSource(id as UsageLimitSourceId, config);
        },
        { concurrency: 4 },
      );
      yield* publish(snapshots);
    },
    refreshLock.withPermits(1),
    Effect.ignoreCause({ log: true }),
  );

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = Effect.fn("UsageLimitSources.consumeResetCredit")(function* (
    input: UsageLimitSourceConsumeResetCreditInput,
  ) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
    );
    const config = settings.usageLimitSources[input.sourceId];
    if (!config?.enabled || !config.managementKey) {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    const result = yield* api.consume(config, input.accountId, input.creditId);
    const snapshot = yield* readSource(input.sourceId, config, input.accountId);
    const previous = yield* Ref.get(stateRef);
    yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
    return result;
  }, refreshLock.withPermits(1));

  // Settings edits re-read straight away so a new hub shows up without
  // waiting for the next scheduled read, and a removed one leaves the list.
  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => refreshSources(true)),
    Effect.forkScoped,
  );

  yield* refreshSources(true).pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    consumeResetCredit,
    refresh: refreshSources(false),
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make);
