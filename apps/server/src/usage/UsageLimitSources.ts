import {
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ProviderDriverKind,
  type ServerSettings,
  UsageLimitSourceConfig,
  settingsSecretLiteral,
  type UsageLimitSourceAccount,
  type UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { antigravityWindowLimitsModel, hubRoutes } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  isUsageLimitsThrottled,
  resolveUsageLimitsAfterProbe,
  USAGE_LIMITS_MIN_READ_GAP_MS,
} from "@t3tools/provider-core/server/usageLimits";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import { resolveSettingsSecrets } from "../secrets/settingsSecretValue.ts";
import * as Settings from "../serverSettings.ts";
import { windowLimitsModel } from "../provider/claudeUsageLimits.ts";
import { makeCliproxyApi, type ListedAccount } from "./cliproxyApi.ts";
import {
  measuredSpend,
  recordSpendSample,
  ABANDONED_HISTORY_HOURS,
  type SpendSample,
} from "./usageSpendHistory.ts";

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

function missingManagementKey(config: UsageLimitSourceConfig): string {
  return typeof config.managementKey === "string"
    ? "No management key configured."
    : "Could not read the management key from its secret provider.";
}

/** The account's last reading, when the same hub read it for the same login. */
function lastReadingOf(
  published: UsageLimitSourceSnapshot | undefined,
  endpoint: string | undefined,
  account: ListedAccount,
): UsageLimitSourceAccount | undefined {
  if (!published || published.endpoint !== endpoint) return undefined;
  // Auth file names can be reused, so without a listed login the next one cannot be told apart.
  if (account.email === undefined && account.workspaceId === undefined) return undefined;
  return published.accounts.find(
    (candidate) =>
      candidate.id === account.id &&
      candidate.driver === account.driver &&
      // Fingerprinted Antigravity readings omit the listed identity, so they are never lent.
      candidate.usageLimits.credentialFingerprint === undefined &&
      candidate.email === account.email &&
      candidate.workspaceId === account.workspaceId,
  );
}

// Readings of each hub account window, kept across restarts so the measured pace survives deploys.
const SPEND_HISTORY_FILE = "usage-spend-history.json";
const SpendHistoryFile = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Array(Schema.Tuple([Schema.Number, Schema.Number, Schema.NullOr(Schema.Number)])),
  ),
);
const decodeSpendHistory = Schema.decodeUnknownEffect(SpendHistoryFile);
const encodeSpendHistory = Schema.encodeEffect(SpendHistoryFile);

/** @public */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const readManagementKey = Effect.fn("UsageLimitSources.readManagementKey")(function* (
    config: UsageLimitSourceConfig,
  ) {
    const resolved = yield* resolveSettingsSecrets(secrets, UsageLimitSourceConfig, config);
    return settingsSecretLiteral(resolved.managementKey);
  });
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const historyPath = path.join(config.stateDir, SPEND_HISTORY_FILE);
  const spendHistory = yield* fileSystem.readFileString(historyPath).pipe(
    Effect.flatMap(decodeSpendHistory),
    Effect.map((record) => new Map<string, readonly SpendSample[]>(Object.entries(record))),
    Effect.orElseSucceed(() => new Map<string, readonly SpendSample[]>()),
    Effect.flatMap((initial) => Ref.make(initial)),
  );
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
    const url = URL.parse(config.url);
    const base = {
      id,
      kind: config.kind,
      label: sourceLabel(id, config),
      ...(url && /^https?:$/.test(url.protocol)
        ? {
            origin: url.origin,
            endpoint: `${url.origin}${url.pathname.replace(/(\/management\.html)?\/*$/i, "")}`,
          }
        : {}),
      checkedAt,
    } as const;
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return { ...base, accounts: [], error: missingManagementKey(config) };
    }
    // A failed account read keeps its last good reading, because the providers rate-limit
    // their quota endpoints (patches/hub-account-last-reading.md). A throttled account is
    // not read again before the time the provider named (patches/usage-limits-refresh.md).
    const published = (yield* Ref.get(stateRef)).find((source) => source.id === id);
    const nowMs = DateTime.toEpochMillis(now);
    const accounts = yield* api
      .readAccounts({ url: config.url, managementKey }, (account) => {
        const last = lastReadingOf(published, base.endpoint, account);
        if (!last || account.id === fresh || !isUsageLimitsThrottled(last.usageLimits, nowMs)) {
          return undefined;
        }
        const { models: _, ...reading } = last;
        return reading;
      })
      .pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logWarning("usage limit source read failed", { id, cause: accounts.failure });
      return { ...base, accounts: [], error: accounts.failure.detail };
    }
    return {
      ...base,
      accounts: accounts.success.map((account) => {
        // An account that cannot sign in contributes no usable quota, so its last reading goes.
        if (account.signInRequired) return account;
        const last = lastReadingOf(published, base.endpoint, account);
        if (!last) return account;
        const usageLimits = resolveUsageLimitsAfterProbe({
          published: last.usageLimits,
          probed: account.usageLimits,
        });
        // The whole account, since a failed read also loses the plan; an unread model list
        // stays unknown.
        return !usageLimits || usageLimits === account.usageLimits
          ? account
          : { ...last, usageLimits, models: account.models };
      }),
    };
  });

  /** Records each account window's reading and attaches what it spent per hour lately. */
  const withMeasuredSpend = Effect.fn("UsageLimitSources.withMeasuredSpend")(function* (
    snapshots: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const history = new Map(yield* Ref.get(spendHistory));
    let changed = false;
    const decorated = snapshots.map((source) => ({
      ...source,
      accounts: source.accounts.map((account) => {
        // A failed read keeps the last good one, with its time, so it records nothing new.
        const readAt = Date.parse(account.usageLimits.checkedAt);
        const at = Number.isFinite(readAt) ? readAt : nowMs;
        return {
          ...account,
          usageLimits: {
            ...account.usageLimits,
            windows: account.usageLimits.windows.map(({ recentSpend: _, ...window }) => {
              const key = `${source.id}\u0000${account.id}\u0000${window.id}`;
              const previous = history.get(key) ?? [];
              const recentSpend = measuredSpend(previous, window, at);
              const samples = recordSpendSample(previous, window, at);
              if (samples !== previous) {
                history.set(key, samples);
                changed = true;
              }
              return recentSpend ? { ...window, recentSpend } : window;
            }),
          },
        };
      }),
    }));
    // Accounts or hubs that are gone stop being read; drop them once their readings age out.
    for (const [key, samples] of history) {
      if ((samples.at(-1)?.[0] ?? 0) < nowMs - ABANDONED_HISTORY_HOURS * 3_600_000) {
        history.delete(key);
        changed = true;
      }
    }
    if (changed) {
      yield* Ref.set(spendHistory, history);
      yield* encodeSpendHistory(Object.fromEntries(history)).pipe(
        Effect.flatMap((contents) =>
          writeFileStringAtomically({ filePath: historyPath, contents }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("usage spend history write failed", { cause }),
        ),
      );
    }
    return decorated;
  });

  const publish = Effect.fn("UsageLimitSources.publish")(function* (
    measured: ReadonlyArray<UsageLimitSourceSnapshot>,
  ) {
    const next = yield* withMeasuredSpend(measured);
    const changed = yield* Ref.modify(stateRef, (previous) =>
      Equal.equals(previous, next) ? [false, previous] : [true, next],
    );
    if (changed) yield* PubSub.publish(changes, next);
  });

  // Serialize refreshes so slow old-settings reads cannot resurrect removed sources after newer
  // refreshes. A caller that queued behind a read of a source reuses that read.
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
    if (!config?.enabled) {
      return yield* new UsageLimitSourceError({
        detail: "The usage limit source is missing or disabled.",
      });
    }
    const managementKey = yield* readManagementKey(config);
    if (managementKey.length === 0) {
      return yield* new UsageLimitSourceError({ detail: missingManagementKey(config) });
    }
    const result = yield* api.consume(
      { url: config.url, managementKey },
      input.accountId,
      input.creditId,
    );
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

export const layer = Layer.effect(UsageLimitSources, make).pipe(
  Layer.provide(SecretResolverLayer.layer),
);

/** A hub returns a usage limit only when every account it routes the model to is spent. */
export function hubPoolResetAt(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  driver: ProviderDriverKind,
  model: string | null,
  now: number,
): string | null {
  let earliest: number | null = null;
  const routes = hubRoutes(sources, driver, model);
  for (const account of sources.flatMap((source) => source.accounts).filter(routes)) {
    // An unread account may be the one still blocked, so its refill is unknown.
    if (account.usageLimits.unavailable) return null;
    const spent = account.usageLimits.windows.filter(
      (window) =>
        window.usedPercent >= 100 &&
        windowLimitsModel(window, model) &&
        (account.driver !== "antigravity" || antigravityWindowLimitsModel(window, model)),
    );
    if (spent.length === 0) return null;
    const resets = spent.map((window) => Date.parse(window.resetsAt ?? ""));
    if (resets.some((reset) => !Number.isFinite(reset))) return null;
    const recoversAt = Math.max(...resets);
    if (recoversAt <= now) return null;
    earliest = earliest === null ? recoversAt : Math.min(earliest, recoversAt);
  }
  return earliest === null ? null : DateTime.formatIso(DateTime.makeUnsafe(earliest));
}

export class UsageLimitResetFallback extends Context.Reference<{
  readonly resetAt: (
    driver: ProviderDriverKind,
    endpoint: string,
    model: string | null,
  ) => Effect.Effect<string | null>;
}>("t3/usage/UsageLimitResetFallback", {
  defaultValue: () => ({ resetAt: () => Effect.succeed(null) }),
}) {}

export const layerResetFallback = Layer.effect(
  UsageLimitResetFallback,
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources;
    return {
      resetAt: Effect.fn("UsageLimitResetFallback.resetAt")(function* (driver, endpoint, model) {
        // Only the hub at the instance's endpoint serves its turns.
        const atEndpoint = Effect.map(sources.current, (current) =>
          current.filter((source) => source.origin === endpoint),
        );
        if ((yield* atEndpoint).length === 0) return null;
        // The pool usually ran out after the last poll, so the cached accounts still show room.
        yield* sources.refresh.pipe(Effect.timeout("5 seconds"), Effect.ignore);
        return hubPoolResetAt(
          yield* atEndpoint,
          driver,
          model,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
      }),
    };
  }),
);
