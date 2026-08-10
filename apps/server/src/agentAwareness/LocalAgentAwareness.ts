import {
  AgentAwarenessServiceError,
  type AgentAwarenessRegistrationResult,
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

const DEVICE_REGISTRATIONS_SECRET = "agent-awareness-devices-v1";
const TERMINAL_DISPLAY_TTL_MS = 15 * 60 * 1_000;
const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;
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
  if (!newest) return null;
  const terminalOnly = active.length === 0;
  return {
    title: "T3 Code",
    subtitle: terminalOnly
      ? newest.phase === "failed"
        ? "Agent work failed"
        : "Agent work completed"
      : "Agent work in progress",
    activeCount: active.length,
    updatedAt: newest.updatedAt,
    activities: displayed.length > 0 ? displayed.map(aggregateRow) : [aggregateRow(newest)],
  };
}

function preferenceAllowsAlert(
  registration: RelayDeviceRegistrationRequestType,
  phase: RelayAgentActivityState["phase"],
): boolean {
  const preferences = registration.preferences;
  if (!preferences.notificationsEnabled) return false;
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    default:
      return false;
  }
}

export function alertForLocalAgentActivityTransition(input: {
  readonly previous: RelayAgentActivityAggregateStateType | null;
  readonly next: RelayAgentActivityAggregateStateType | null;
  readonly registration: RelayDeviceRegistrationRequestType;
  readonly nowMs: number;
}): ApnsProvider.ApnsAlert | null {
  return notificationForTransition(input)?.alert ?? null;
}

function notificationForTransition(input: {
  readonly previous: RelayAgentActivityAggregateStateType | null;
  readonly next: RelayAgentActivityAggregateStateType | null;
  readonly registration: RelayDeviceRegistrationRequestType;
  readonly nowMs: number;
}) {
  for (const nextRow of input.next?.activities ?? []) {
    if (!preferenceAllowsAlert(input.registration, nextRow.phase)) continue;
    const previousRow = input.previous?.activities.find((row) => row.threadId === nextRow.threadId);
    if (previousRow?.phase === nextRow.phase) continue;
    if (nextRow.phase === "completed" || nextRow.phase === "failed") {
      const updatedAt = Option.match(DateTime.make(nextRow.updatedAt), {
        onNone: () => null,
        onSome: (value) => value.epochMilliseconds,
      });
      if (updatedAt === null || input.nowMs - updatedAt > TERMINAL_NOTIFICATION_FRESHNESS_MS) {
        continue;
      }
    }
    return {
      alert: {
        title: nextRow.threadTitle,
        body: `${nextRow.status}: ${nextRow.projectTitle}`,
      },
      row: nextRow,
    };
  }
  return null;
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
    readonly publish: (input: {
      readonly threadId: string;
      readonly state: RelayAgentActivityState | null;
    }) => Effect.Effect<void, never>;
  }
>()("t3/agentAwareness/LocalAgentAwareness") {}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const apns = yield* ApnsProvider.ApnsProvider;
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

  const currentAggregate = Effect.gen(function* () {
    const now = yield* DateTime.now;
    return makeLocalAgentActivityAggregate({
      states: [...(yield* Ref.get(statesRef)).values()],
      terminalState: null,
      nowMs: now.epochMilliseconds,
    });
  });

  const deliverToDevice = Effect.fn("LocalAgentAwareness.deliverToDevice")(function* (input: {
    readonly device: StoredDevice;
    readonly aggregate: RelayAgentActivityAggregateStateType | null;
    readonly terminalState: RelayAgentActivityState | null;
    readonly nowMs: number;
  }) {
    if (!apns.configured) return input.device;
    const notification = notificationForTransition({
      previous: input.device.lastAggregate,
      next: input.aggregate,
      registration: input.device.registration,
      nowMs: input.nowMs,
    });
    const liveActivityToken = input.device.activityPushToken;
    if (liveActivityToken) {
      const target = deliveryTarget(input.device, liveActivityToken);
      if (!target) return input.device;
      const shouldEnd =
        input.aggregate === null ||
        input.device.registration.preferences.liveActivitiesEnabled === false ||
        (input.aggregate.activeCount === 0 && input.terminalState !== null);
      const result = yield* apns
        .sendLiveActivity({
          target,
          event: shouldEnd ? "end" : "update",
          state: input.aggregate,
          alert: notification?.alert ?? null,
        })
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
        activityPushToken:
          shouldEnd || permanentTokenFailure(result) ? null : input.device.activityPushToken,
        lastAggregate: result.ok ? input.aggregate : input.device.lastAggregate,
      };
    }
    const pushToken = input.device.registration.pushToken;
    if (!notification || !pushToken) return input.device;
    const target = deliveryTarget(input.device, pushToken);
    if (!target) return input.device;
    const result = yield* apns
      .sendNotification({
        target,
        title: notification.alert.title,
        body: notification.alert.body,
        environmentId: notification.row.environmentId,
        threadId: notification.row.threadId,
        deepLink: notification.row.deepLink,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Accountless push notification delivery failed", {
            deviceId: input.device.registration.deviceId,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
    if (result === null) return input.device;
    const registration = permanentTokenFailure(result)
      ? { ...input.device.registration, pushToken: undefined }
      : input.device.registration;
    return {
      ...input.device,
      registration,
      lastAggregate: result.ok ? input.aggregate : input.device.lastAggregate,
    };
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
        const now = yield* DateTime.now;
        const states = [...(yield* Ref.get(statesRef)).values()];
        const terminalState = input.state && isTerminal(input.state) ? input.state : null;
        const aggregate = makeLocalAgentActivityAggregate({
          states,
          terminalState,
          nowMs: now.epochMilliseconds,
        });
        yield* Ref.get(devicesRef).pipe(
          Effect.flatMap((devices) =>
            Effect.forEach(
              devices.values(),
              (device) =>
                deliverToDevice({
                  device,
                  aggregate,
                  terminalState,
                  nowMs: now.epochMilliseconds,
                }).pipe(Effect.map((updated) => ({ before: device, updated }))),
              { concurrency: 2 },
            ),
          ),
          Effect.flatMap((deliveries) =>
            mutateDevices((devices) => {
              for (const { before, updated } of deliveries) {
                const current = devices.get(before.registration.deviceId);
                if (!current) continue;
                const registration =
                  current.registration.pushToken === before.registration.pushToken
                    ? withPushToken(current.registration, updated.registration.pushToken)
                    : current.registration;
                devices.set(current.registration.deviceId, {
                  registration,
                  activityPushToken:
                    current.activityPushToken === before.activityPushToken
                      ? updated.activityPushToken
                      : current.activityPushToken,
                  lastAggregate: updated.lastAggregate,
                });
              }
              return [undefined, devices];
            }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Accountless agent-awareness publication failed", { cause }),
          ),
        );
      }),
    );
  });

  return LocalAgentAwareness.of({
    registerDevice: Effect.fn("LocalAgentAwareness.registerDevice")(function* (registration) {
      yield* mutateDevices((devices) => {
        const previous = devices.get(registration.deviceId);
        devices.set(registration.deviceId, {
          registration,
          activityPushToken: previous?.activityPushToken ?? null,
          lastAggregate: previous?.lastAggregate ?? null,
        });
        return [undefined, devices];
      });
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
        const now = yield* DateTime.now;
        const updated = yield* deliverToDevice({
          device,
          aggregate,
          terminalState: null,
          nowMs: now.epochMilliseconds,
        });
        yield* mutateDevices((devices) => {
          devices.set(updated.registration.deviceId, updated);
          return [undefined, devices];
        });
      }
      return { accepted: true, deliveryConfigured: apns.configured };
    }),
    getSnapshot: currentAggregate.pipe(Effect.map((aggregate) => ({ aggregate }))),
    publish,
  });
});

export const layer = Layer.effect(LocalAgentAwareness, make);
