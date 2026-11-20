import {
  AgentAwarenessServiceError,
  type AgentAwarenessRegistrationResult,
  type NeedsYouSubjectKind,
} from "@t3tools/contracts";
import {
  RelayAgentActivityAggregateState,
  type RelayAgentActivityAggregateState as RelayAgentActivityAggregateStateType,
  type RelayAgentActivityState,
  RelayDeviceRegistrationRequest,
  type RelayDeviceRegistrationRequest as RelayDeviceRegistrationRequestType,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ApnsProvider from "./ApnsProvider.ts";
import type { NeedsYouDeliveryOutcome } from "./NeedsYouLedger.ts";

/** An alert for the phone. */
export interface NeedsYouPush {
  readonly title: string;
  readonly body: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly deepLink: string;
  /** Which switch in the app's notification settings governs it. */
  readonly kind: NeedsYouSubjectKind;
  /** Alerts that take one another's place on the phone share it. */
  readonly collapseKey: string;
}

export interface AlertDelivery<E> {
  readonly token: string;
  /** The alert as it goes out now, or null when it no longer does. */
  readonly prepare: Effect.Effect<
    {
      readonly push: NeedsYouPush;
      /** It replaces an alert the device has, without a sound. */
      readonly silent: boolean;
    } | null,
    E
  >;
}

const DEVICE_REGISTRATIONS_SECRET = "agent-awareness-devices-v1";
const TERMINAL_DISPLAY_TTL_MS = 15 * 60 * 1_000;
/** Badge-only pushes wait this long, so a burst of count changes sends one. */
const BADGE_COALESCE_MS = 3_000;
const RUNNING_STATE_TTL_MS = 2 * 60 * 60 * 1_000;
const WAITING_STATE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_ACTIVITY_ROWS = 5;
const MAX_SUMMARY_LENGTH = 120;
const MAX_STATUS_LENGTH = 40;
const MAX_DEEP_LINK_LENGTH = 512;

const StoredDevice = Schema.Struct({
  registration: RelayDeviceRegistrationRequest,
  activityPushToken: Schema.NullOr(Schema.String),
  lastAggregate: Schema.NullOr(RelayAgentActivityAggregateState),
  /** The count the app icon last got. Absent on registrations stored before badges. */
  lastBadge: Schema.optional(Schema.Int),
});
type StoredDevice = typeof StoredDevice.Type;

const StoredDevices = Schema.Array(StoredDevice);
const StoredDevicesJson = Schema.fromJsonString(StoredDevices);
const decodeStoredDevices = Schema.decodeEffect(StoredDevicesJson);
const encodeStoredDevices = Schema.encodeEffect(StoredDevicesJson);

function serviceError(message: string, cause?: unknown): AgentAwarenessServiceError {
  return new AgentAwarenessServiceError({
    message: cause === undefined ? message : `${message}: ${String(cause)}`,
  });
}

function isTerminal(state: RelayAgentActivityState): boolean {
  return state.phase === "completed" || state.phase === "failed";
}

function sameAgentActivityState(
  left: RelayAgentActivityState | null,
  right: RelayAgentActivityState | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId &&
    left.projectTitle === right.projectTitle &&
    left.threadTitle === right.threadTitle &&
    left.phase === right.phase &&
    left.headline === right.headline &&
    left.detail === right.detail &&
    left.modelTitle === right.modelTitle &&
    left.deepLink === right.deepLink
  );
}

function stateUpdatedAtMs(state: RelayAgentActivityState): number | null {
  return Option.match(DateTime.make(state.updatedAt), {
    onNone: () => null,
    onSome: (value) => value.epochMilliseconds,
  });
}

function isExpiredState(state: RelayAgentActivityState, nowMs: number): boolean {
  const updatedAtMs = stateUpdatedAtMs(state);
  if (updatedAtMs === null) return true;
  const ttlMs =
    state.phase === "starting" || state.phase === "running"
      ? RUNNING_STATE_TTL_MS
      : WAITING_STATE_TTL_MS;
  return nowMs - updatedAtMs > ttlMs;
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
}

function safeDeepLink(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("/") && !trimmed.startsWith("//")
    ? truncate(trimmed, MAX_DEEP_LINK_LENGTH)
    : "/";
}

function statusForPhase(phase: RelayAgentActivityState["phase"]): string {
  switch (phase) {
    case "starting":
      return "Connecting";
    case "running":
      return "Working";
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "stale":
      return "Waiting";
  }
}

function aggregateRow(state: RelayAgentActivityState) {
  return {
    environmentId: state.environmentId,
    threadId: state.threadId,
    projectTitle: truncate(state.projectTitle, MAX_SUMMARY_LENGTH),
    threadTitle: truncate(state.threadTitle, MAX_SUMMARY_LENGTH),
    modelTitle: truncate(state.modelTitle, MAX_SUMMARY_LENGTH),
    phase: state.phase,
    status: truncate(statusForPhase(state.phase), MAX_STATUS_LENGTH),
    updatedAt: state.updatedAt,
    deepLink: safeDeepLink(state.deepLink),
  };
}

export function makeLocalAgentActivityAggregate(input: {
  readonly states: ReadonlyArray<RelayAgentActivityState>;
  readonly terminalState: RelayAgentActivityState | null;
  readonly nowMs: number;
  /** Threads that need the user, once the needs-you tracker has counted them. */
  readonly attentionCount?: number | null;
}): RelayAgentActivityAggregateStateType | null {
  const active = input.states
    .filter((state) => !isTerminal(state) && !isExpiredState(state, input.nowMs))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const recentTerminal = input.states
    .filter((state) => {
      if (!isTerminal(state)) return false;
      const updatedAtMs = stateUpdatedAtMs(state);
      return updatedAtMs !== null && input.nowMs - updatedAtMs <= TERMINAL_DISPLAY_TTL_MS;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const displayed = [...active.slice(0, MAX_ACTIVITY_ROWS), ...recentTerminal].slice(
    0,
    MAX_ACTIVITY_ROWS,
  );
  const newest = [...active, ...recentTerminal].reduce<RelayAgentActivityState | null>(
    (latest, state) =>
      latest === null || state.updatedAt.localeCompare(latest.updatedAt) > 0 ? state : latest,
    input.terminalState,
  );
  if (!newest) {
    // The widget still shows how many threads need the user when no row is left.
    return input.attentionCount == null || input.attentionCount === 0
      ? null
      : {
          title: "T3 Code",
          subtitle: "Waiting for you",
          activeCount: 0,
          attentionCount: input.attentionCount,
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(input.nowMs)),
          activities: [],
        };
  }
  const terminalOnly = active.length === 0;
  return {
    title: "T3 Code",
    subtitle: terminalOnly
      ? newest.phase === "failed"
        ? "Agent work failed"
        : "Agent work completed"
      : "Agent work in progress",
    activeCount: active.length,
    ...(input.attentionCount == null ? {} : { attentionCount: input.attentionCount }),
    updatedAt: newest.updatedAt,
    activities: displayed.length > 0 ? displayed.map(aggregateRow) : [aggregateRow(newest)],
  };
}

function preferenceAllows(
  registration: RelayDeviceRegistrationRequestType,
  kind: NeedsYouPush["kind"],
): boolean {
  const preferences = registration.preferences;
  if (!preferences.notificationsEnabled) return false;
  switch (kind) {
    case "approval":
      return preferences.notifyOnApproval;
    case "input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    case "digest":
      return true;
  }
}

// Questions and finished or failed work get a Reply action. Approvals stay tap-to-open.
function notificationCategory(
  kind: NeedsYouPush["kind"],
): ApnsProvider.ApnsNotificationCategory | undefined {
  switch (kind) {
    case "input":
      return "AGENT_INPUT";
    case "completed":
    case "failed":
      return "AGENT_DONE";
    default:
      return undefined;
  }
}

function deliveryOutcome(result: ApnsProvider.ApnsDeliveryResult): NeedsYouDeliveryOutcome {
  if (result.ok) return "accepted";
  // Throttling, server trouble and an expired provider token pass; other refusals do not.
  return result.status === 429 || result.status === 403 || result.status >= 500
    ? "failed"
    : "rejected";
}

function permanentTokenFailure(result: ApnsProvider.ApnsDeliveryResult): boolean {
  return (
    result.status === 410 ||
    (result.status === 400 &&
      (result.reason === "BadDeviceToken" ||
        result.reason === "DeviceTokenNotForTopic" ||
        result.reason === "Unregistered"))
  );
}

function deliveryTarget(device: StoredDevice, token: string) {
  const bundleId = device.registration.bundleId;
  const environment = device.registration.apsEnvironment;
  return bundleId && environment ? { token, bundleId, environment } : null;
}

function withPushToken(
  registration: RelayDeviceRegistrationRequestType,
  pushToken: string | undefined,
): RelayDeviceRegistrationRequestType {
  const { pushToken: _previous, ...rest } = registration;
  return pushToken ? { ...rest, pushToken } : rest;
}

export class LocalAgentAwareness extends Context.Service<
  LocalAgentAwareness,
  {
    readonly registerDevice: (
      input: RelayDeviceRegistrationRequestType,
    ) => Effect.Effect<AgentAwarenessRegistrationResult, AgentAwarenessServiceError>;
    readonly unregisterDevice: (
      deviceId: string,
    ) => Effect.Effect<{ readonly removed: boolean }, AgentAwarenessServiceError>;
    readonly registerLiveActivity: (input: {
      readonly deviceId: string;
      readonly activityPushToken: string;
    }) => Effect.Effect<AgentAwarenessRegistrationResult, AgentAwarenessServiceError>;
    readonly getSnapshot: Effect.Effect<
      { readonly aggregate: RelayAgentActivityAggregateStateType | null },
      never
    >;
    /** Updates the Live Activity. Alerts come from `deliverAlert`, never from these rows. */
    readonly publish: (input: {
      readonly threadId: string;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<void, never>;
    /**
     * How many threads need the user: the app icon badge and the Live Activity's count. Badge
     * pushes coalesce for a few seconds and catch up any device whose last one failed.
     */
    readonly setNeedsYouCount: (count: number) => Effect.Effect<void, never>;
    /** Push tokens of the devices that want this kind of alert. */
    readonly alertTargets: (
      kind: NeedsYouPush["kind"],
    ) => Effect.Effect<ReadonlyArray<string>, never>;
    /**
     * Sends one alert to the device with this push token, carrying the current count. `prepare`
     * runs once this alert holds the publication lock, right before the request, and returns the
     * alert or null when it no longer goes out ("cancelled").
     */
    readonly deliverAlert: <E>(
      input: AlertDelivery<E>,
    ) => Effect.Effect<NeedsYouDeliveryOutcome | "cancelled", E>;
  }
>()("t3/agentAwareness/LocalAgentAwareness") {}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const apns = yield* ApnsProvider.ApnsProvider;
  const scope = yield* Effect.scope;
  const storageLock = yield* Semaphore.make(1);
  const publicationLock = yield* Semaphore.make(1);
  const encodedDevices = yield* secrets
    .get(DEVICE_REGISTRATIONS_SECRET)
    .pipe(
      Effect.mapError((cause) => serviceError("Could not read mobile device registrations", cause)),
    );
  const initialDevices = yield* Option.match(encodedDevices, {
    onNone: () => Effect.succeed([] as ReadonlyArray<StoredDevice>),
    onSome: (bytes) =>
      decodeStoredDevices(new TextDecoder().decode(bytes)).pipe(
        Effect.mapError((cause) =>
          serviceError("Stored mobile device registrations are invalid", cause),
        ),
      ),
  });
  const devicesRef = yield* Ref.make(
    new Map(initialDevices.map((device) => [device.registration.deviceId, device])),
  );
  const statesRef = yield* Ref.make(new Map<string, RelayAgentActivityState>());
  const needsYouRef = yield* Ref.make<number | null>(null);
  let flushScheduled = false;

  const persistDevices = Effect.fn("LocalAgentAwareness.persistDevices")(function* (
    devices: ReadonlyMap<string, StoredDevice>,
  ) {
    const json = yield* encodeStoredDevices([...devices.values()]).pipe(
      Effect.mapError((cause) =>
        serviceError("Could not encode mobile device registrations", cause),
      ),
    );
    yield* secrets
      .set(DEVICE_REGISTRATIONS_SECRET, new TextEncoder().encode(json))
      .pipe(
        Effect.mapError((cause) =>
          serviceError("Could not persist mobile device registrations", cause),
        ),
      );
  });

  const mutateDevices = <A>(
    update: (devices: Map<string, StoredDevice>) => readonly [A, Map<string, StoredDevice>],
  ) =>
    storageLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(devicesRef);
        const [result, next] = update(new Map(current));
        yield* persistDevices(next);
        yield* Ref.set(devicesRef, next);
        return result;
      }),
    );

  const aggregateAt = Effect.fnUntraced(function* (
    nowMs: number,
    terminalState: RelayAgentActivityState | null,
  ) {
    // Untraced: a pure read of two refs inside traced publications.
    return makeLocalAgentActivityAggregate({
      states: [...(yield* Ref.get(statesRef)).values()],
      terminalState,
      nowMs,
      attentionCount: yield* Ref.get(needsYouRef),
    });
  });

  const currentAggregate = Effect.gen(function* () {
    return yield* aggregateAt((yield* DateTime.now).epochMilliseconds, null);
  });

  const pushTargetOf = (device: StoredDevice) => {
    const pushToken = device.registration.pushToken;
    return pushToken ? deliveryTarget(device, pushToken) : null;
  };

  const withoutToken = (device: StoredDevice, result: ApnsProvider.ApnsDeliveryResult) =>
    permanentTokenFailure(result)
      ? { ...device, registration: { ...device.registration, pushToken: undefined } }
      : device;

  const deliverToDevice = Effect.fn("LocalAgentAwareness.deliverToDevice")(function* (input: {
    readonly device: StoredDevice;
    readonly aggregate: RelayAgentActivityAggregateStateType | null;
    readonly terminalState: RelayAgentActivityState | null;
  }) {
    const liveActivityToken = input.device.activityPushToken;
    if (!apns.configured || !liveActivityToken) return input.device;
    const target = deliveryTarget(input.device, liveActivityToken);
    if (!target) return input.device;
    // A count without rows is for the widget; the card ends.
    const aggregate = (input.aggregate?.activities.length ?? 0) > 0 ? input.aggregate : null;
    const shouldEnd =
      aggregate === null ||
      input.device.registration.preferences.liveActivitiesEnabled === false ||
      (aggregate.activeCount === 0 && input.terminalState !== null);
    const result = yield* apns
      .sendLiveActivity({ target, event: shouldEnd ? "end" : "update", state: aggregate })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Accountless Live Activity delivery failed", {
            deviceId: input.device.registration.deviceId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
    if (result === null) return input.device;
    return {
      ...input.device,
      // An end APNs did not take, such as on a 503, is sent again with the next publication.
      activityPushToken:
        (shouldEnd && result.ok) || permanentTokenFailure(result)
          ? null
          : input.device.activityPushToken,
      lastAggregate: result.ok ? input.aggregate : input.device.lastAggregate,
    };
  });

  /** Writes back what deliveries learned, keeping registrations that changed meanwhile. */
  const saveDeliveries = (
    deliveries: ReadonlyArray<{ readonly before: StoredDevice; readonly updated: StoredDevice }>,
  ) =>
    mutateDevices((devices) => {
      for (const { before, updated } of deliveries) {
        const current = devices.get(before.registration.deviceId);
        if (!current) continue;
        const sameToken = current.registration.pushToken === before.registration.pushToken;
        const registration = sameToken
          ? withPushToken(current.registration, updated.registration.pushToken)
          : current.registration;
        const lastBadge = sameToken ? updated.lastBadge : current.lastBadge;
        devices.set(current.registration.deviceId, {
          registration,
          activityPushToken:
            current.activityPushToken === before.activityPushToken
              ? updated.activityPushToken
              : current.activityPushToken,
          lastAggregate: updated.lastAggregate,
          ...(lastBadge === undefined ? {} : { lastBadge }),
        });
      }
      return [undefined, devices];
    });

  const forEachDevice = (
    label: string,
    deliver: (device: StoredDevice) => Effect.Effect<StoredDevice>,
  ) =>
    Ref.get(devicesRef).pipe(
      Effect.flatMap((devices) =>
        Effect.forEach(
          devices.values(),
          (device) => deliver(device).pipe(Effect.map((updated) => ({ before: device, updated }))),
          { concurrency: 2 },
        ),
      ),
      Effect.flatMap(saveDeliveries),
      Effect.catch((cause) => Effect.logWarning(label, { cause })),
    );

  const wantsBadge = (device: StoredDevice, count: number) =>
    device.lastBadge !== count &&
    device.registration.preferences.notificationsEnabled &&
    pushTargetOf(device) !== null;

  const sendBadge = Effect.fn("LocalAgentAwareness.sendBadge")(function* (
    device: StoredDevice,
    badge: number,
  ) {
    const target = pushTargetOf(device);
    if (target === null || !wantsBadge(device, badge)) return device;
    const result = yield* apns.sendBadge({ target, badge }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Accountless badge delivery failed", {
          deviceId: device.registration.deviceId,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    // A failed attempt keeps the old count, so the next reconcile tries again.
    if (result === null) return device;
    const updated = withoutToken(device, result);
    return result.ok ? { ...updated, lastBadge: badge } : updated;
  });

  /** Brings every device's icon count and Live Activity count to the current one. */
  const flushCount = publicationLock.withPermits(1)(
    Effect.gen(function* () {
      const count = yield* Ref.get(needsYouRef);
      if (count === null || !apns.configured) return;
      const aggregate = yield* aggregateAt((yield* DateTime.now).epochMilliseconds, null);
      yield* forEachDevice("Accountless badge publication failed", (device) =>
        Effect.gen(function* () {
          const updated =
            device.lastAggregate?.attentionCount === aggregate?.attentionCount
              ? device
              : yield* deliverToDevice({ device, aggregate, terminalState: null });
          return yield* sendBadge(updated, count);
        }),
      );
    }),
  );

  const scheduleFlush = Effect.suspend(() => {
    if (flushScheduled) return Effect.void;
    flushScheduled = true;
    return Effect.sleep(BADGE_COALESCE_MS).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          flushScheduled = false;
          return flushCount;
        }),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  });

  const publish: LocalAgentAwareness["Service"]["publish"] = Effect.fn(
    "LocalAgentAwareness.publish",
  )(function* (input) {
    return yield* publicationLock.withPermits(1)(
      Effect.gen(function* () {
        const currentState = (yield* Ref.get(statesRef)).get(input.threadId) ?? null;
        if (sameAgentActivityState(currentState, input.state)) return;
        yield* Ref.update(statesRef, (states) => {
          const next = new Map(states);
          if (input.state) next.set(input.threadId, input.state);
          else next.delete(input.threadId);
          return next;
        });
        if (!apns.configured) return;
        const terminalState = input.state && isTerminal(input.state) ? input.state : null;
        const aggregate = yield* aggregateAt(
          (yield* DateTime.now).epochMilliseconds,
          terminalState,
        );
        yield* forEachDevice("Accountless agent-awareness publication failed", (device) =>
          deliverToDevice({ device, aggregate, terminalState }),
        );
      }),
    );
  });

  const setNeedsYouCount: LocalAgentAwareness["Service"]["setNeedsYouCount"] = Effect.fn(
    "LocalAgentAwareness.setNeedsYouCount",
  )(function* (count) {
    const changed = (yield* Ref.getAndSet(needsYouRef, count)) !== count;
    const devices = yield* Ref.get(devicesRef);
    if (changed || [...devices.values()].some((device) => wantsBadge(device, count))) {
      yield* scheduleFlush;
    }
  });

  const alertTargets: LocalAgentAwareness["Service"]["alertTargets"] = (kind) =>
    Ref.get(devicesRef).pipe(
      Effect.map((devices) =>
        apns.configured
          ? [...devices.values()].flatMap((device) => {
              const target = pushTargetOf(device);
              return target !== null && preferenceAllows(device.registration, kind)
                ? [target.token]
                : [];
            })
          : [],
      ),
    );

  const deliverAlert: LocalAgentAwareness["Service"]["deliverAlert"] = Effect.fn(
    "LocalAgentAwareness.deliverAlert",
  )(function* <E>({ token, prepare }: AlertDelivery<E>) {
    return yield* publicationLock.withPermits(1)(
      Effect.gen(function* () {
        // A badge or Live Activity request may have held the lock for seconds: decided now.
        const prepared = yield* prepare;
        if (prepared === null) return "cancelled" as const;
        const { push, silent } = prepared;
        const device = [...(yield* Ref.get(devicesRef)).values()].find(
          (candidate) => candidate.registration.pushToken === token,
        );
        const target = device === undefined ? null : pushTargetOf(device);
        if (
          !apns.configured ||
          device === undefined ||
          target === null ||
          !preferenceAllows(device.registration, push.kind)
        ) {
          return "gone" as const;
        }
        const badge = (yield* Ref.get(needsYouRef)) ?? undefined;
        const urgent = (push.kind === "approval" || push.kind === "input") && !silent;
        const result = yield* apns
          .sendNotification({
            target,
            title: push.title,
            body: push.body,
            environmentId: push.environmentId,
            threadId: push.threadId,
            deepLink: push.deepLink,
            category: notificationCategory(push.kind),
            // A blocked agent is worth breaking through Focus for; finished work can wait.
            interruptionLevel: urgent ? "time-sensitive" : undefined,
            badge,
            silent,
            collapseId: ApnsProvider.apnsCollapseId(push.collapseKey),
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Accountless push notification delivery failed", {
                deviceId: device.registration.deviceId,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
        // No answer: APNs may have the alert or not. It is tried again, and its collapse id
        // folds a second copy into the first on the phone.
        if (result === null) return "failed" as const;
        const updated = withoutToken(device, result);
        yield* saveDeliveries([
          {
            before: device,
            updated: result.ok && badge !== undefined ? { ...updated, lastBadge: badge } : updated,
          },
        ]).pipe(
          Effect.catch((cause) => Effect.logWarning("Accountless device update failed", { cause })),
        );
        return deliveryOutcome(result);
      }),
    );
  });

  return LocalAgentAwareness.of({
    registerDevice: Effect.fn("LocalAgentAwareness.registerDevice")(function* (registration) {
      yield* mutateDevices((devices) => {
        const previous = devices.get(registration.deviceId);
        // A new token has no count yet, so the next reconcile sends one.
        const lastBadge =
          previous?.registration.pushToken === registration.pushToken
            ? previous?.lastBadge
            : undefined;
        devices.set(registration.deviceId, {
          registration,
          activityPushToken: previous?.activityPushToken ?? null,
          lastAggregate: previous?.lastAggregate ?? null,
          ...(lastBadge === undefined ? {} : { lastBadge }),
        });
        return [undefined, devices];
      });
      yield* scheduleFlush;
      return { accepted: true, deliveryConfigured: apns.configured };
    }),
    unregisterDevice: Effect.fn("LocalAgentAwareness.unregisterDevice")(function* (deviceId) {
      return yield* mutateDevices((devices) => {
        const removed = devices.delete(deviceId);
        return [{ removed }, devices];
      });
    }),
    registerLiveActivity: Effect.fn("LocalAgentAwareness.registerLiveActivity")(function* (input) {
      const device = yield* mutateDevices((devices) => {
        const current = devices.get(input.deviceId);
        if (!current) return [null, devices] as const;
        const next = { ...current, activityPushToken: input.activityPushToken };
        devices.set(input.deviceId, next);
        return [next, devices] as const;
      });
      if (!device) {
        return yield* serviceError("Register the mobile device before its Live Activity token");
      }
      const aggregate = yield* currentAggregate;
      if (aggregate && apns.configured) {
        const updated = yield* deliverToDevice({ device, aggregate, terminalState: null });
        // The phone may have registered again meanwhile, such as with a new push token: only the
        // Live Activity's result is written, and only while its token is the current one.
        yield* mutateDevices((devices) => {
          const current = devices.get(device.registration.deviceId);
          if (current?.activityPushToken === device.activityPushToken) {
            devices.set(current.registration.deviceId, {
              ...current,
              activityPushToken: updated.activityPushToken,
              lastAggregate: updated.lastAggregate,
            });
          }
          return [undefined, devices];
        });
      }
      return { accepted: true, deliveryConfigured: apns.configured };
    }),
    getSnapshot: currentAggregate.pipe(Effect.map((aggregate) => ({ aggregate }))),
    publish,
    setNeedsYouCount,
    alertTargets,
    deliverAlert,
  });
});

export const layer = Layer.effect(LocalAgentAwareness, make);
