import { type LiveActivity } from "expo-widgets";
import {
  configureAndroidAgentNotifications,
  clearAndroidAgentNotifications,
} from "./androidNotifications";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AppState, Platform } from "react-native";
import { msg } from "gt-react-native";
import type {
  AgentAwarenessDeviceRegistrationInput,
  AgentAwarenessLiveActivityRegistrationInput,
  AgentAwarenessRegistrationResult,
  AgentAwarenessSnapshot,
  EnvironmentId,
} from "@t3tools/contracts";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  settleAsyncResult,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { m } from "../../i18n/messages";
import { runtime } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { MobilePreferencesStore, type Preferences } from "../../persistence/mobile-preferences";
import * as MobileStorage from "../../persistence/mobile-storage";
import {
  clearAgentAwarenessRegistrationRecord,
  loadPreferences,
} from "../../persistence/imperative";
import type { AgentActivityProps } from "../../widgets/AgentActivity";
import {
  agentActivityText,
  type AgentActivityWidgetSource,
} from "../../widgets/agentActivityWidgetTimeline";
import { publishAgentActivityWidget } from "../../widgets/publishAgentActivityWidget";
import {
  dismissEndedAgentLiveActivities,
  getAgentLiveActivities,
  startAgentLiveActivity,
} from "./agentLiveActivity";
import { supportsAgentAwarenessPush } from "./capabilities";
import {
  makeAgentAwarenessDeviceRegistrationInput,
  resolveApsEnvironment,
} from "./registrationPayload";

const REMOTE_ACTIVITY_REGISTRATION_RETRY_MS = 15_000;
const DEVICE_UNREGISTRATION_TIMEOUT = "5 seconds";

const AgentAwarenessOperation = Schema.Literals([
  "read-notification-permissions",
  "read-native-push-token",
  "register-device-with-environment",
  "unregister-device-with-environment",
  "register-live-activity-with-environment",
  "read-agent-awareness-snapshot",
  "load-device-registration-identifier",
  "load-device-registration-preferences",
  "load-device-unregistration-identifier",
  "read-live-activity-push-token",
  "load-live-activity-registration-identifier",
  "list-active-live-activities",
  "load-live-activity-prime-preferences",
  "prime-live-activity",
  "load-registration-record",
]);

export class AgentAwarenessOperationError extends Schema.TaggedError<AgentAwarenessOperationError>()(
  "AgentAwarenessOperationError",
  {
    operation: AgentAwarenessOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Agent awareness operation ${this.operation} failed.`;
  }
}

export class AgentAwarenessDeliveryUnavailableError extends Schema.TaggedError<AgentAwarenessDeliveryUnavailableError>()(
  "AgentAwarenessDeliveryUnavailableError",
  {},
) {
  override get message(): string {
    return "The paired server has no APNs provider credentials configured.";
  }
}

export type AgentAwarenessRegistrationError =
  | AgentAwarenessOperationError
  | AgentAwarenessDeliveryUnavailableError;

export type AgentAwarenessRegistrationServices =
  | MobileStorage.MobileStorage
  | MobilePreferencesStore;

// ActivityKit returns new wrappers per id; serialize by id to prevent stale-token registration.
const activityPushTokenLocks = new Map<string, Semaphore.Semaphore>();
// Each accepted registration replays the server aggregate, repairing drifted or orphaned activities.
const ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS = 60_000;
// Match the paired server's STALE_AFTER_SECONDS (apps/server agentAwareness/ApnsProvider.ts) so
// activities expire even if registration fails.
const LIVE_ACTIVITY_STALE_AFTER_MS = 10 * 60_000;
const liveActivityStaleDate = () => new Date(Date.now() + LIVE_ACTIVITY_STALE_AFTER_MS);
const registeredActivityPushTokens = new Map<string, number>();
// Refreshes can overlap (environment activation, foreground, retry); only the newest read may
// repaint, so a slow older response never overwrites newer rows.
let widgetSnapshotReads = 0;
let androidDeviceReplayedAt: number | null = null;
let lastNativePushToken: string | null = null;
let registeredWithPushToken = false;
let nativePushTokenRotations = 0;
let pushTokenSubscription: { remove: () => void } | null = null;
let appStateSubscription: { remove: () => void } | null = null;

export type AgentAwarenessRegistrationStatus = "unknown" | "pending" | "registered" | "failed";
let registrationStatus: AgentAwarenessRegistrationStatus = "unknown";
const registrationStatusListeners = new Set<() => void>();

function setRegistrationStatus(
  next: AgentAwarenessRegistrationStatus,
  withPushToken = registeredWithPushToken,
): void {
  if (registrationStatus === next && registeredWithPushToken === withPushToken) {
    return;
  }
  registrationStatus = next;
  registeredWithPushToken = withPushToken;
  for (const listener of registrationStatusListeners) {
    listener();
  }
}

export function getAgentAwarenessRegistrationStatus(): AgentAwarenessRegistrationStatus {
  return registrationStatus;
}

// Live Activities use their own push tokens, so device registration alone does not mean
// the relay can deliver notifications.
export function agentAwarenessNotificationsReady(): boolean {
  return registrationStatus === "registered" && registeredWithPushToken;
}

export function subscribeAgentAwarenessRegistrationStatus(listener: () => void): () => void {
  registrationStatusListeners.add(listener);
  return () => {
    registrationStatusListeners.delete(listener);
  };
}
let activeLiveActivityRegistrationRetry: ReturnType<typeof setTimeout> | null = null;
export interface AgentAwarenessEnvironmentTransport {
  readonly identity: string;
  /** Also says which environment took the registration. */
  readonly registerDevice: (
    input: AgentAwarenessDeviceRegistrationInput,
  ) => Promise<AgentAwarenessRegistrationResult & { readonly environmentId: EnvironmentId }>;
  /** `owner` is the environment that took the device registration, once known. */
  readonly registerLiveActivity: (
    input: AgentAwarenessLiveActivityRegistrationInput,
    owner: EnvironmentId | null,
  ) => Promise<AgentAwarenessRegistrationResult>;
  readonly getSnapshot: (owner: EnvironmentId | null) => Promise<AgentAwarenessSnapshot>;
}

let environmentTransport: AgentAwarenessEnvironmentTransport | null = null;
// The environment that took the device registration: it sends the pushes, so the app icon, the
// widget and the Live Activity read it too. Kept in the registration record across launches,
// which skip registering again.
let deviceOwner: EnvironmentId | null = null;
// The last paired environment was removed, unlike a remount that releases the transport.
let pairedEnvironmentsRemoved = false;
let deviceRegistrationGeneration = 0;
let activeDeviceRegistration: {
  readonly input: DeviceRegistrationInput;
  operation: Promise<void>;
} | null = null;
let pendingDeviceRegistration: {
  readonly input: DeviceRegistrationInput;
  readonly context: string;
} | null = null;

interface DeviceRegistrationInput {
  readonly observedPushToken?: string;
}

interface RegisterDeviceInput extends DeviceRegistrationInput {
  readonly preferencesOverride?: Partial<Preferences>;
}

export function mergeAgentAwarenessRegistrationPreferences(
  stored: Preferences,
  override: Partial<Preferences> | undefined,
): Preferences {
  return { ...stored, ...override };
}

function canRegisterRemoteLiveActivities(): boolean {
  return Platform.OS === "ios";
}

function canRegisterPushNotifications(): boolean {
  return Platform.OS === "ios" || Platform.OS === "android";
}

export function setAgentAwarenessEnvironmentTransport(
  transport: AgentAwarenessEnvironmentTransport | null,
): void {
  const isExistingIdentity =
    transport !== null && environmentTransport?.identity === transport.identity;
  if (!isExistingIdentity) {
    if (environmentTransport && transport?.identity !== environmentTransport.identity) {
      clearAndroidAgentNotifications();
    }
    androidDeviceReplayedAt = null;
    deviceRegistrationGeneration++;
    activeDeviceRegistration = null;
    pendingDeviceRegistration = null;
    registeredActivityPushTokens.clear();
    deviceOwner = null;
  }
  environmentTransport = transport;
  pairedEnvironmentsRemoved = transport === null;
  if (!transport) {
    clearAndroidAgentNotifications();
    pushTokenSubscription?.remove();
    pushTokenSubscription = null;
    appStateSubscription?.remove();
    appStateSubscription = null;
    if (activeLiveActivityRegistrationRetry) {
      clearTimeout(activeLiveActivityRegistrationRetry);
      activeLiveActivityRegistrationRetry = null;
    }
    // With no paired environment left, nothing can update or end the activities.
    endLocalLiveActivities("live activity cleanup after removing the last environment failed");
    setRegistrationStatus("unknown");
    return;
  }
  ensurePushTokenListener();
  ensureAppStateListener();
  runRegistrationInBackground(
    refreshActiveLiveActivityRemoteRegistration(),
    "active live activity registration after paired environment activation failed",
  );
  if (isExistingIdentity) {
    // Reinstalling the same environment transport normally needs no
    // re-registration — but if the previous attempt never succeeded, this is
    // the only trigger that will retry it before the next cold start.
    if (registrationStatus !== "registered") {
      enqueueDeviceRegistration({}, "device registration retry after environment refresh failed");
    }
    return;
  }
  enqueueDeviceRegistration({}, "device registration after environment activation failed");
}

// Remounts and environment list changes keep the registration and lock-screen activities.
export function releaseAgentAwarenessEnvironmentTransport(): void {
  environmentTransport = null;
  deviceRegistrationGeneration++;
  activeDeviceRegistration = null;
  pendingDeviceRegistration = null;
  androidDeviceReplayedAt = null;
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
  if (activeLiveActivityRegistrationRetry) {
    clearTimeout(activeLiveActivityRegistrationRetry);
    activeLiveActivityRegistrationRetry = null;
  }
}

// Upstream's CloudAuthProvider hands T3 Connect credentials to relay-backed awareness through
// these hooks. Devices register with paired environments here, so account changes leave
// registration alone (patches/accountless-direct-agent-awareness.md).
export function setAgentAwarenessRelayTokenProvider(
  _provider: (() => Promise<string | null>) | null,
  _identity?: string,
): void {}

export function releaseAgentAwarenessRelayTokenProvider(): void {}

export function unregisterAgentAwarenessDeviceForCurrentUser(
  _tokenProvider: () => Promise<string | null>,
): Effect.Effect<void> {
  return Effect.void;
}

function iosMajorVersion(): number {
  const version = Platform.Version;
  if (typeof version === "number") {
    return Math.floor(version);
  }
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 18;
}

const nativePushTokenRegistration = Effect.fn("remoteRegistration.nativePushTokenRegistration")(
  function* (observedPushToken?: string) {
    if (!canRegisterPushNotifications() || !supportsAgentAwarenessPush()) {
      return { notificationsEnabled: false, pushToken: null, notificationPermissionGranted: false };
    }
    const permissions = yield* Effect.tryPromise({
      try: () => Notifications.getPermissionsAsync(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-notification-permissions",
          cause,
        }),
    });
    // Android FCM data delivery is independent of notification presentation permission.
    if (!permissions.granted && Platform.OS !== "android") {
      return { notificationsEnabled: false, pushToken: null, notificationPermissionGranted: false };
    }
    const alertsEnabled =
      permissions.granted &&
      (Platform.OS === "android" && Number(Platform.Version) >= 26
        ? yield* Effect.tryPromise({
            try: () => Notifications.getNotificationChannelAsync("agent-alerts"),
            catch: (cause) =>
              new AgentAwarenessOperationError({
                operation: "read-notification-permissions",
                cause,
              }),
          }).pipe(
            Effect.map((channel) => channel?.importance !== Notifications.AndroidImportance.NONE),
            Effect.orElseSucceed(() => false),
          )
        : true);
    if (observedPushToken) {
      lastNativePushToken = observedPushToken;
      nativePushTokenRotations++;
      return {
        notificationsEnabled: alertsEnabled,
        pushToken: observedPushToken,
        notificationPermissionGranted: permissions.granted,
      };
    }
    const rotationsBeforeLookup = nativePushTokenRotations;
    const token = yield* Effect.tryPromise({
      try: () => Notifications.getDevicePushTokenAsync(),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-native-push-token",
          cause,
        }),
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          logRegistrationError("native push token lookup failed", error);
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    const lookedUpPushToken =
      token?.type === Platform.OS && typeof token.data === "string" && token.data.trim().length > 0
        ? token.data.trim()
        : null;
    // A rotation observed while this lookup ran is newer than what the lookup returned.
    if (lookedUpPushToken && rotationsBeforeLookup === nativePushTokenRotations) {
      lastNativePushToken = lookedUpPushToken;
    }
    const pushToken = lastNativePushToken;
    // A missing token must not disable notifications the relay accepted.
    return {
      notificationsEnabled: alertsEnabled,
      pushToken,
      notificationPermissionGranted: permissions.granted,
    };
  },
);

function registrationSignature(body: AgentAwarenessDeviceRegistrationInput): string {
  return [
    body.deviceId,
    body.pushToken ?? "",
    body.bundleId ?? "",
    body.apsEnvironment ?? "",
    body.appVersion ?? "",
    body.label,
    body.platform,
    body.iosMajorVersion,
    body.androidApiLevel,
    body.preferences.notificationsEnabled,
    body.preferences.liveActivitiesEnabled,
    body.preferences.notifyOnApproval,
    body.preferences.notifyOnInput,
    body.preferences.notifyOnCompletion,
    body.preferences.notifyOnFailure,
  ].join("|");
}

const registerDeviceWithEnvironment = Effect.fn("remoteRegistration.registerDeviceWithEnvironment")(
  function* (
    body: AgentAwarenessDeviceRegistrationInput,
    expectedGeneration: number,
  ): Effect.fn.Return<void, AgentAwarenessRegistrationError, AgentAwarenessRegistrationServices> {
    if (expectedGeneration !== deviceRegistrationGeneration) {
      return;
    }
    const transport = environmentTransport;
    if (!transport) {
      setRegistrationStatus("unknown");
      return;
    }

    // Skip the request when this environment set already accepted an identical
    // payload. Pairing identity changes invalidate the record automatically.
    const identity = transport.identity;
    const storage = yield* MobileStorage.MobileStorage;
    const persisted = yield* storage.loadAgentAwarenessRegistrationRecord.pipe(
      Effect.mapError(
        (cause) =>
          new AgentAwarenessOperationError({ operation: "load-registration-record", cause }),
      ),
      Effect.orElseSucceed(() => null),
    );
    if (expectedGeneration !== deviceRegistrationGeneration) {
      // The paired environment set changed while the record loaded.
      return;
    }
    const payload = body;
    const signature = `${identity}|${registrationSignature(payload)}`;
    const now = yield* Clock.currentTimeMillis;
    const needsAndroidReplay =
      body.platform === "android" &&
      (androidDeviceReplayedAt === null ||
        now - androidDeviceReplayedAt >= ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS);
    // A record from before owners were kept registers again to learn its owner.
    if (
      persisted &&
      persisted.identity === identity &&
      persisted.signature === signature &&
      persisted.owner !== undefined &&
      !needsAndroidReplay
    ) {
      deviceOwner = persisted.owner as EnvironmentId;
      setRegistrationStatus("registered", Boolean(payload.pushToken));
      return;
    }

    const result = yield* Effect.tryPromise({
      try: () => transport.registerDevice(payload),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "register-device-with-environment",
          cause,
        }),
    });
    if (!result.deliveryConfigured) {
      setRegistrationStatus("failed");
      return yield* new AgentAwarenessDeliveryUnavailableError({});
    }
    if (expectedGeneration !== deviceRegistrationGeneration) {
      return;
    }
    if (body.platform === "android") {
      androidDeviceReplayedAt = yield* Clock.currentTimeMillis;
    }
    deviceOwner = result.environmentId;
    setRegistrationStatus("registered", Boolean(payload.pushToken));
    yield* storage
      .saveAgentAwarenessRegistrationRecord({ identity, signature, owner: result.environmentId })
      .pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            logRegistrationError("persist registration record failed", error);
          }),
        ),
      );
  },
);

function environmentPublishesAgentActivity(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .agentActivityPublishing !== false
  );
}

export function armAgentAwarenessLiveActivityForLocalWork(input: {
  readonly environmentId: EnvironmentId;
  readonly threadTitle: string;
  readonly projectTitle: string;
}): void {
  if (!canRegisterRemoteLiveActivities()) {
    return;
  }
  if (!environmentPublishesAgentActivity(input.environmentId)) {
    return;
  }
  void loadPreferences()
    .catch(() => null)
    .then((preferences) => {
      if (preferences?.liveActivitiesEnabled === false) {
        return;
      }
      armAgentAwarenessLiveActivityForLocalWorkNow(input);
    });
}

function armAgentAwarenessLiveActivityForLocalWorkNow(input: {
  readonly threadTitle: string;
  readonly projectTitle: string;
}): void {
  try {
    if (getAgentLiveActivities().length > 0) {
      return;
    }
    const nowIso = new Date(Date.now()).toISOString();
    const props = {
      text: agentActivityText(1, m),
      title: "T3 Code",
      subtitle: m(msg("Agent work in progress")),
      activeCount: 1,
      updatedAt: nowIso,
      activities: [
        {
          environmentId: "",
          threadId: "",
          projectTitle: input.projectTitle,
          threadTitle: input.threadTitle,
          modelTitle: "",
          phase: "starting",
          status: m(msg("Connecting", { $context: "agent status" })),
          updatedAt: nowIso,
          deepLink: "/",
        },
      ],
    } satisfies AgentActivityProps;
    publishWidget({ kind: "snapshot", aggregate: props });
    const activity = startAgentLiveActivity(props, liveActivityStaleDate());
    if (!activity) return;
    runRegistrationInBackground(
      registerLiveActivityPushToken({ activity }).pipe(Effect.asVoid),
      "live activity arming after local task start failed",
    );
  } catch (error) {
    logRegistrationError("live activity arming failed", error);
  }
}

/**
 * The environment that owns this device's pushes. Right after a launch the registration has not
 * restored it yet, so it comes from the stored record of these paired environments.
 */
const deviceOwnerOf = Effect.fn("remoteRegistration.deviceOwnerOf")(function* (
  transport: AgentAwarenessEnvironmentTransport,
) {
  if (deviceOwner !== null) return deviceOwner;
  const storage = yield* MobileStorage.MobileStorage;
  const record = yield* storage.loadAgentAwarenessRegistrationRecord.pipe(
    Effect.mapError(
      (cause) => new AgentAwarenessOperationError({ operation: "load-registration-record", cause }),
    ),
    Effect.orElseSucceed(() => null),
  );
  return record?.identity === transport.identity && record.owner !== undefined
    ? (record.owner as EnvironmentId)
    : null;
});

const readAgentActivitySnapshot: (
  /** Only from the owner, null while it is not known: the icon's count is the owner's alone. */
  ownerOnly?: boolean,
) => Effect.Effect<AgentAwarenessSnapshot | null, never, MobileStorage.MobileStorage> = Effect.fn(
  "remoteRegistration.readAgentActivitySnapshot",
)(
  function* (ownerOnly = false) {
    const transport = environmentTransport;
    if (!transport) return null;
    const owner = yield* deviceOwnerOf(transport);
    if (owner === null && ownerOnly) return null;
    return yield* Effect.tryPromise({
      try: () => transport.getSnapshot(owner),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "read-agent-awareness-snapshot",
          cause,
        }),
    });
  },
  Effect.catch((error) =>
    Effect.sync(() => {
      logRegistrationError("agent activity snapshot read failed", error);
      return null;
    }),
  ),
);

/**
 * The app icon's count: the needs-you count of the server that sends this device's pushes, 0 once
 * no server is paired, null while it cannot be read or that server is not known yet.
 */
export function readAppIconCount(): Promise<number | null> {
  if (environmentTransport === null) return Promise.resolve(pairedEnvironmentsRemoved ? 0 : null);
  return runtime
    .runPromise(readAgentActivitySnapshot(true))
    .then((snapshot) => (snapshot === null ? null : (snapshot.aggregate?.attentionCount ?? 0)));
}

const registerLiveActivityWithEnvironment = Effect.fn(
  "remoteRegistration.registerLiveActivityWithEnvironment",
)(function* (
  body: AgentAwarenessLiveActivityRegistrationInput,
): Effect.fn.Return<boolean, AgentAwarenessOperationError, MobileStorage.MobileStorage> {
  const transport = environmentTransport;
  if (!transport) return false;
  const owner = yield* deviceOwnerOf(transport);
  const result = yield* Effect.tryPromise({
    try: () => transport.registerLiveActivity(body, owner),
    catch: (cause) =>
      new AgentAwarenessOperationError({
        operation: "register-live-activity-with-environment",
        cause,
      }),
  });
  return result.deliveryConfigured;
});

function logRegistrationError(context: string, error: unknown): void {
  if (!__DEV__) {
    return;
  }
  console.warn(`[agent-awareness] ${context}`, {
    message: error instanceof Error ? error.message : String(error),
    traceId: findErrorTraceId(error),
    error,
  });
}

function runRegistrationInBackground<E>(
  operation: Effect.Effect<unknown, E, AgentAwarenessRegistrationServices>,
  context: string,
): void {
  void (async () => {
    const result = await settleAsyncResult(() => runtime.runPromiseExit(operation));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      logRegistrationError(context, squashAtomCommandFailure(result));
    }
  })();
}

function mergeDeviceRegistrationInput(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): DeviceRegistrationInput {
  const observedPushToken = next.observedPushToken ?? current.observedPushToken;
  return observedPushToken ? { observedPushToken } : {};
}

function registrationAddsInformation(
  current: DeviceRegistrationInput,
  next: DeviceRegistrationInput,
): boolean {
  return (
    next.observedPushToken !== undefined && next.observedPushToken !== current.observedPushToken
  );
}

function startPendingDeviceRegistration(): void {
  if (activeDeviceRegistration || !pendingDeviceRegistration) {
    return;
  }

  const next = pendingDeviceRegistration;
  pendingDeviceRegistration = null;
  const generation = deviceRegistrationGeneration;
  if (registrationStatus !== "registered") {
    setRegistrationStatus("pending");
  }
  const registration = {
    input: next.input,
    operation: Promise.resolve(),
  };
  activeDeviceRegistration = registration;
  registration.operation = (async () => {
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(registerDevice(next.input, generation)),
    );
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      // Refresh failures leave the server's accepted registration intact; preserve registered status.
      // A paired-environment change meanwhile owns the status, so an obsolete run leaves it alone.
      if (generation === deviceRegistrationGeneration && registrationStatus !== "registered") {
        setRegistrationStatus("failed");
      }
      logRegistrationError(next.context, squashAtomCommandFailure(result));
    }
    if (activeDeviceRegistration === registration) {
      activeDeviceRegistration = null;
    }
    startPendingDeviceRegistration();
  })();
}

function enqueueDeviceRegistration(input: DeviceRegistrationInput, context: string): void {
  if (
    activeDeviceRegistration &&
    !registrationAddsInformation(activeDeviceRegistration.input, input)
  ) {
    return;
  }

  pendingDeviceRegistration = pendingDeviceRegistration
    ? {
        input: mergeDeviceRegistrationInput(pendingDeviceRegistration.input, input),
        context,
      }
    : { input, context };
  startPendingDeviceRegistration();
}

const registerDevice = Effect.fn("remoteRegistration.registerDevice")(function* (
  input: RegisterDeviceInput = {},
  expectedGeneration = deviceRegistrationGeneration,
): Effect.fn.Return<void, AgentAwarenessRegistrationError, AgentAwarenessRegistrationServices> {
  if (!canRegisterPushNotifications()) {
    return;
  }
  if (!environmentTransport) {
    setRegistrationStatus("unknown");
    return;
  }

  const storage = yield* MobileStorage.MobileStorage;
  const preferencesStore = yield* MobilePreferencesStore;
  const [deviceId, storedPreferences] = yield* Effect.all([
    storage.loadOrCreateAgentAwarenessDeviceId.pipe(
      Effect.mapError(
        (cause) =>
          new AgentAwarenessOperationError({
            operation: "load-device-registration-identifier",
            cause,
          }),
      ),
    ),
    preferencesStore.load.pipe(
      Effect.mapError(
        (cause) =>
          new AgentAwarenessOperationError({
            operation: "load-device-registration-preferences",
            cause,
          }),
      ),
    ),
  ]);
  const preferences = mergeAgentAwarenessRegistrationPreferences(
    storedPreferences,
    input.preferencesOverride,
  );
  if (expectedGeneration !== deviceRegistrationGeneration) return;
  const transport = environmentTransport;
  if (Platform.OS === "android" && transport) {
    configureAndroidAgentNotifications(
      deviceId,
      transport.identity,
      preferences.liveActivitiesEnabled !== false,
    );
  }
  const pushTokenRegistration = yield* nativePushTokenRegistration(input?.observedPushToken);
  const bundleId =
    Platform.OS === "android"
      ? Constants.expoConfig?.android?.package?.trim()
      : Constants.expoConfig?.ios?.bundleIdentifier?.trim();
  yield* registerDeviceWithEnvironment(
    makeAgentAwarenessDeviceRegistrationInput({
      deviceId,
      label:
        Constants.deviceName?.trim() ||
        // oxlint-disable-next-line t3code/no-untranslated-copy -- device label stored on the relay and shown to every client
        (Platform.OS === "android" ? "Android device" : "iOS device"),
      ...(Platform.OS === "android"
        ? {
            platform: "android" as const,
            androidApiLevel: Number(Platform.Version),
            notificationPermissionGranted: pushTokenRegistration.notificationPermissionGranted,
          }
        : { platform: "ios" as const, iosMajorVersion: iosMajorVersion() }),
      appVersion: Constants.expoConfig?.version,
      ...(bundleId ? { bundleId } : {}),
      ...(Platform.OS === "ios"
        ? {
            apsEnvironment: resolveApsEnvironment(
              Constants.expoConfig?.extra?.apnsEnvironment,
              Constants.expoConfig?.extra?.appVariant,
            ),
          }
        : {}),
      ...(pushTokenRegistration.pushToken ? { pushToken: pushTokenRegistration.pushToken } : {}),
      notificationsEnabled: pushTokenRegistration.notificationsEnabled,
      preferences,
    }),
    expectedGeneration,
  );
});

function ensurePushTokenListener(): void {
  if (pushTokenSubscription || !canRegisterPushNotifications()) {
    return;
  }

  pushTokenSubscription = Notifications.addPushTokenListener((token) => {
    if (
      token.type === Platform.OS &&
      typeof token.data === "string" &&
      token.data.trim().length > 0
    ) {
      enqueueDeviceRegistration(
        { observedPushToken: token.data.trim() },
        "native push token rotation registration failed",
      );
    }
  });
}

function ensureAppStateListener(): void {
  if (appStateSubscription || !canRegisterPushNotifications()) {
    return;
  }

  appStateSubscription = AppState.addEventListener("change", (state) => {
    if (state !== "active") {
      return;
    }
    enqueueDeviceRegistration({}, "device registration after app foreground failed");
    runRegistrationInBackground(
      refreshActiveLiveActivityRemoteRegistration(),
      "active live activity reconciliation after app foreground failed",
    );
  });
}

function publishWidget(source: AgentActivityWidgetSource): void {
  if (!canRegisterRemoteLiveActivities()) {
    return;
  }
  publishAgentActivityWidget(source).catch((error: unknown) => {
    logRegistrationError("agent activity widget publish failed", error);
  });
}

/** Retries a device registration that has not succeeded, such as one that ran before connecting. */
export function retryAgentAwarenessRegistration(): void {
  if (environmentTransport && registrationStatus !== "registered") {
    enqueueDeviceRegistration({}, "device registration after environment connection failed");
  }
}

export function refreshAgentAwarenessRegistration(): Effect.Effect<
  void,
  never,
  AgentAwarenessRegistrationServices
> {
  return Effect.suspend(() => {
    const generation = deviceRegistrationGeneration;
    return registerDevice(undefined, generation).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (generation === deviceRegistrationGeneration && registrationStatus !== "registered") {
            setRegistrationStatus("failed");
          }
          logRegistrationError("device registration refresh failed", error);
        }),
      ),
    );
  });
}

export function updateAgentAwarenessRegistrationPreferences(
  preferencesOverride: Partial<Preferences>,
): Effect.Effect<void, AgentAwarenessRegistrationError, AgentAwarenessRegistrationServices> {
  return Effect.suspend(() => {
    const generation = deviceRegistrationGeneration;
    return registerDevice({ preferencesOverride }, generation).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (generation === deviceRegistrationGeneration && registrationStatus !== "registered") {
            setRegistrationStatus("failed");
          }
          logRegistrationError("device preference registration refresh failed", error);
        }),
      ),
    );
  });
}

export function __resetAgentAwarenessRemoteRegistrationForTest(): void {
  environmentTransport = null;
  pushTokenSubscription?.remove();
  pushTokenSubscription = null;
  appStateSubscription?.remove();
  appStateSubscription = null;
  if (activeLiveActivityRegistrationRetry) {
    clearTimeout(activeLiveActivityRegistrationRetry);
    activeLiveActivityRegistrationRetry = null;
  }
  deviceRegistrationGeneration++;
  activeDeviceRegistration = null;
  pendingDeviceRegistration = null;
  registrationStatus = "unknown";
  registeredWithPushToken = false;
  androidDeviceReplayedAt = null;
  deviceOwner = null;
  lastNativePushToken = null;
  nativePushTokenRotations = 0;
  registrationStatusListeners.clear();
  registeredActivityPushTokens.clear();
  activityPushTokenLocks.clear();
  widgetSnapshotReads = 0;
}

/**
 * Asks one paired environment to forget this device before the user removes it,
 * so the removed server stops sending notifications and Live Activity updates.
 * Best effort and bounded: an unreachable server must not block removal.
 */
export async function unregisterAgentAwarenessDeviceFromEnvironment(
  unregister: (deviceId: string) => Promise<void>,
): Promise<void> {
  const operation = Effect.gen(function* () {
    const storage = yield* MobileStorage.MobileStorage;
    const deviceId = yield* storage.loadAgentAwarenessDeviceId.pipe(
      Effect.mapError(
        (cause) =>
          new AgentAwarenessOperationError({
            operation: "load-device-unregistration-identifier",
            cause,
          }),
      ),
    );
    if (!deviceId) {
      return;
    }
    // A registration still in flight must not reach the server or save its skip record after this
    // request; that record would stop the next registration from reaching the server. Callers then
    // change the registration environments, which starts a fresh registration.
    deviceRegistrationGeneration++;
    yield* Effect.promise(() =>
      clearAgentAwarenessRegistrationRecord().catch((error: unknown) => {
        logRegistrationError("clear registration record failed", error);
      }),
    );
    yield* Effect.tryPromise({
      try: () => unregister(deviceId),
      catch: (cause) =>
        new AgentAwarenessOperationError({
          operation: "unregister-device-with-environment",
          cause,
        }),
    });
  }).pipe(Effect.timeout(DEVICE_UNREGISTRATION_TIMEOUT));
  const result = await settleAsyncResult(() => runtime.runPromiseExit(operation));
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    logRegistrationError("device unregistration failed", squashAtomCommandFailure(result));
  }
}

export const registerLiveActivityPushToken = Effect.fn(
  "remoteRegistration.registerLiveActivityPushToken",
)(function* (input: {
  readonly activity: LiveActivity<AgentActivityProps>;
}): Effect.fn.Return<boolean, AgentAwarenessOperationError, AgentAwarenessRegistrationServices> {
  if (!canRegisterRemoteLiveActivities()) {
    return false;
  }

  const lock = observeLiveActivityPushTokens(input.activity);
  return yield* lock.withPermit(
    Effect.gen(function* () {
      const activityPushToken = yield* Effect.tryPromise({
        try: () => input.activity.getPushToken(),
        catch: (cause) =>
          new AgentAwarenessOperationError({
            operation: "read-live-activity-push-token",
            cause,
          }),
      });
      if (!activityPushToken) {
        return false;
      }

      return yield* registerLiveActivityPushTokenValue({ activityPushToken });
    }),
  );
});

// Observe every token replacement: the server otherwise keeps pushing to the old token until APNs rejects it.
function observeLiveActivityPushTokens(
  activity: LiveActivity<AgentActivityProps>,
): Semaphore.Semaphore {
  const activityId = activity.getId();
  const existing = activityPushTokenLocks.get(activityId);
  if (existing) return existing;
  const lock = Semaphore.makeUnsafe(1);
  activityPushTokenLocks.set(activityId, lock);
  activity.addPushTokenListener((event) => {
    if (!event.pushToken) return;
    runRegistrationInBackground(
      lock.withPermit(registerLiveActivityPushTokenValue({ activityPushToken: event.pushToken })),
      "live activity token listener registration failed",
    );
  });
  return lock;
}

const registerLiveActivityPushTokenValue = Effect.fn(
  "remoteRegistration.registerLiveActivityPushTokenValue",
)(function* (input: {
  readonly activityPushToken: string;
}): Effect.fn.Return<boolean, AgentAwarenessOperationError, AgentAwarenessRegistrationServices> {
  const acceptedAt = registeredActivityPushTokens.get(input.activityPushToken);
  if (
    acceptedAt !== undefined &&
    (yield* Clock.currentTimeMillis) - acceptedAt < ACTIVITY_TOKEN_REREGISTER_INTERVAL_MS
  ) {
    return true;
  }
  const storage = yield* MobileStorage.MobileStorage;
  const deviceId = yield* storage.loadOrCreateAgentAwarenessDeviceId.pipe(
    Effect.mapError(
      (cause) =>
        new AgentAwarenessOperationError({
          operation: "load-live-activity-registration-identifier",
          cause,
        }),
    ),
  );
  const registered = yield* registerLiveActivityWithEnvironment({
    deviceId,
    activityPushToken: input.activityPushToken,
  });
  if (registered) {
    registeredActivityPushTokens.set(input.activityPushToken, yield* Clock.currentTimeMillis);
  }
  return registered;
});

// Binaries built before the native dismissEnded method throw here.
function dismissEndedLocalLiveActivities(): void {
  try {
    dismissEndedAgentLiveActivities();
  } catch (error) {
    logRegistrationError("ended live activity cleanup failed", error);
  }
}

function endLocalLiveActivities(context: string): void {
  if (!canRegisterRemoteLiveActivities()) {
    return;
  }
  dismissEndedLocalLiveActivities();
  try {
    for (const activity of getAgentLiveActivities()) {
      activity.end("immediate").catch((error: unknown) => {
        logRegistrationError(context, error);
      });
    }
  } catch (error) {
    logRegistrationError(context, error);
  }
}

function scheduleActiveLiveActivityRegistrationRetry(): void {
  if (activeLiveActivityRegistrationRetry || !environmentTransport) {
    return;
  }

  activeLiveActivityRegistrationRetry = setTimeout(() => {
    activeLiveActivityRegistrationRetry = null;
    runRegistrationInBackground(
      refreshActiveLiveActivityRemoteRegistration(),
      "active live activity token retry failed",
    );
  }, REMOTE_ACTIVITY_REGISTRATION_RETRY_MS);
}

export const refreshActiveLiveActivityRemoteRegistration = Effect.fn(
  "remoteRegistration.refreshActiveLiveActivityRemoteRegistration",
)(function* (): Effect.fn.Return<void, never, AgentAwarenessRegistrationServices> {
  if (!canRegisterRemoteLiveActivities() || !environmentTransport) {
    return;
  }

  dismissEndedLocalLiveActivities();
  let activities = yield* Effect.try({
    try: () => getAgentLiveActivities(),
    catch: (cause) =>
      new AgentAwarenessOperationError({
        operation: "list-active-live-activities",
        cause,
      }),
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logRegistrationError("active live activity lookup failed", error);
        return [] as ReadonlyArray<LiveActivity<AgentActivityProps>>;
      }),
    ),
  );

  // The paired server tracks exactly one card per device; if concurrent arming ever
  // produced extras, end them so only one keeps receiving updates.
  if (activities.length > 1) {
    for (const extra of activities.slice(1)) {
      extra.end("immediate").catch((error: unknown) => {
        logRegistrationError("duplicate live activity cleanup failed", error);
      });
    }
    activities = activities.slice(0, 1);
  }

  // The home-screen widget gets no ActivityKit pushes, so reconcile it on reconnect and foreground.
  // A null aggregate is authoritative idle state; a failed read publishes nothing and keeps the
  // last useful snapshot. Refreshes overlap, and only the newest read for the current environment
  // set may repaint or prime, so a slow older response never brings old rows back.
  const generation = deviceRegistrationGeneration;
  const read = ++widgetSnapshotReads;
  const isNewestRead = () =>
    deviceRegistrationGeneration === generation && read === widgetSnapshotReads;
  const snapshot = yield* readAgentActivitySnapshot();
  if (!isNewestRead()) {
    return;
  }
  if (snapshot) {
    publishWidget({ kind: "snapshot", aggregate: snapshot.aggregate });
  }

  // Activities start only here in the foreground, where the update token registers at once; the
  // server never push-to-starts one because background wakes proved too unreliable. Asking the
  // server for the aggregate first keeps an idle open from creating an empty lock-screen card.
  if (activities.length === 0) {
    const preferencesStore = yield* MobilePreferencesStore;
    const preferences = yield* preferencesStore.load.pipe(
      Effect.mapError(
        (cause) =>
          new AgentAwarenessOperationError({
            operation: "load-live-activity-prime-preferences",
            cause,
          }),
      ),
      Effect.orElseSucceed(() => null),
    );
    if (!isNewestRead()) {
      return;
    }
    // The toggle defaults to on: an unset preference (fresh install) must
    // prime, so only an explicit false blocks it.
    if (preferences?.liveActivitiesEnabled !== false) {
      // The snapshot and preference reads yield; an arm-on-send may have
      // created the card in the meantime. Re-check so two cards are never started.
      const armedMeanwhile = yield* Effect.try({
        try: () => getAgentLiveActivities(),
        catch: () => [] as ReadonlyArray<LiveActivity<AgentActivityProps>>,
      }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<LiveActivity<AgentActivityProps>>));
      if (armedMeanwhile.length > 0) {
        activities = [...armedMeanwhile];
      } else if (snapshot?.aggregate && snapshot.aggregate.activeCount > 0) {
        const aggregate = snapshot.aggregate;
        const primed = yield* Effect.try({
          try: () =>
            startAgentLiveActivity(
              {
                text: agentActivityText(
                  Math.max(
                    aggregate.activeCount,
                    aggregate.activities.length,
                    aggregate.attentionCount ?? 0,
                  ),
                  m,
                ),
                title: aggregate.title,
                subtitle: aggregate.subtitle,
                activeCount: aggregate.activeCount,
                ...(aggregate.attentionCount === undefined
                  ? {}
                  : { attentionCount: aggregate.attentionCount }),
                updatedAt: aggregate.updatedAt,
                activities: aggregate.activities,
              },
              liveActivityStaleDate(),
            ),
          catch: (cause) =>
            new AgentAwarenessOperationError({
              operation: "prime-live-activity",
              cause,
            }),
        }).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              logRegistrationError("live activity priming failed", error);
              return null;
            }),
          ),
        );
        if (primed) {
          activities = [primed];
        }
      }
    }
  }

  const registrationResults = yield* Effect.forEach(activities, (activity) =>
    registerLiveActivityPushToken({ activity }).pipe(
      Effect.map((registered) => !registered),
      Effect.catch((error) =>
        Effect.sync(() => {
          logRegistrationError("active live activity token registration failed", error);
          return true;
        }),
      ),
    ),
  );

  if (registrationResults.some(Boolean)) {
    scheduleActiveLiveActivityRegistrationRetry();
  }
});
