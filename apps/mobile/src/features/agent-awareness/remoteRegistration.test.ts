import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import type { AgentAwarenessSnapshot, EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import { loadPreferences } from "../../persistence/imperative";
import type { Preferences } from "../../persistence/mobile-preferences";
import type { AgentAwarenessEnvironmentTransport } from "./remoteRegistration";
import {
  __resetAgentAwarenessRemoteRegistrationForTest,
  AgentAwarenessDeliveryUnavailableError,
  armAgentAwarenessLiveActivityForLocalWork,
  getAgentAwarenessRegistrationStatus,
  mergeAgentAwarenessRegistrationPreferences,
  refreshActiveLiveActivityRemoteRegistration,
  registerLiveActivityPushToken,
  releaseAgentAwarenessEnvironmentTransport,
  setAgentAwarenessEnvironmentTransport,
  unregisterAgentAwarenessDeviceFromEnvironment,
  updateAgentAwarenessRegistrationPreferences,
} from "./remoteRegistration";
import {
  configureAndroidAgentNotifications,
  clearAndroidAgentNotifications,
} from "./androidNotifications";

const activityMocks = vi.hoisted(() => ({
  dismissEnded: vi.fn(),
  getInstances: vi.fn(() => []),
  start: vi.fn(() => ({})),
}));
const publishWidgetMock = vi.hoisted(() => vi.fn((_source: unknown) => Promise.resolve()));
const environmentConfigsMock = vi.hoisted(() => ({
  configs: new Map<
    string,
    { environment: { capabilities: { agentActivityPublishing?: boolean } } }
  >(),
}));
const registrationRecord = vi.hoisted(() => ({
  value: null as { readonly identity: string; readonly signature: string } | null,
}));

vi.mock("expo-constants", () => ({
  default: {
    deviceName: "Hauke's iPhone",
    expoConfig: {
      version: "1.0.0",
      ios: { bundleIdentifier: "dev.schnau.t3code" },
      extra: { apnsEnvironment: "sandbox", appVariant: "production" },
    },
  },
}));

vi.mock("expo-widgets", () => ({
  addPushToStartTokenListener: vi.fn(() => ({ remove: vi.fn() })),
}));

vi.mock("../../widgets/publishAgentActivityWidget", () => ({
  publishAgentActivityWidget: publishWidgetMock,
}));

vi.mock("./agentLiveActivity", () => ({
  dismissEndedAgentLiveActivities: activityMocks.dismissEnded,
  getAgentLiveActivities: activityMocks.getInstances,
  startAgentLiveActivity: activityMocks.start,
}));
vi.mock("expo-notifications", () => ({
  AndroidImportance: { NONE: 0, HIGH: 4 },
  getNotificationChannelAsync: vi.fn(() => Promise.resolve(null)),
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
  getDevicePushTokenAsync: vi.fn(() => Promise.resolve({ type: "ios", data: "apns-token" })),
  getPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
}));

vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return "ios";
    },
    get Version() {
      return 27;
    },
  },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock("./androidNotifications", () => ({
  configureAndroidAgentNotifications: vi.fn(),
  clearAndroidAgentNotifications: vi.fn(),
  supportsAndroidAgentNotifications: vi.fn(() => true),
}));

vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: () => environmentConfigsMock.configs,
  },
}));

vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: Symbol("environmentServerConfigsAtom"),
}));

// The mock preserves the production runtime's Promise-returning boundary.
// oxlint-disable t3code/no-manual-effect-runtime-in-tests
vi.mock("../../lib/runtime", () => ({
  runtime: {
    runPromiseExit: <A, E>(operation: Effect.Effect<A, E>) => Effect.runPromiseExit(operation),
  },
}));
// oxlint-enable t3code/no-manual-effect-runtime-in-tests

vi.mock("../../persistence/imperative", () => ({
  loadAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadOrCreateAgentAwarenessDeviceId: vi.fn(() => Promise.resolve("device-1")),
  loadPreferences: vi.fn(() => Promise.resolve({ liveActivitiesEnabled: true })),
  loadAgentAwarenessRegistrationRecord: vi.fn(() => Promise.resolve(registrationRecord.value)),
  saveAgentAwarenessRegistrationRecord: vi.fn((value) => {
    registrationRecord.value = value;
    return Promise.resolve();
  }),
}));

function transport(
  overrides: Partial<AgentAwarenessEnvironmentTransport> = {},
): AgentAwarenessEnvironmentTransport {
  return {
    identity: "env-1",
    registerDevice: vi.fn(() =>
      Promise.resolve({ accepted: true as const, deliveryConfigured: true }),
    ),
    registerLiveActivity: vi.fn(() =>
      Promise.resolve({ accepted: true as const, deliveryConfigured: true }),
    ),
    getSnapshot: vi.fn(() => Promise.resolve({ aggregate: null })),
    ...overrides,
  };
}

describe("accountless agent awareness registration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({
      type: "ios",
      data: "apns-token",
    });
    vi.stubGlobal("__DEV__", false);
    __resetAgentAwarenessRemoteRegistrationForTest();
    registrationRecord.value = null;
    environmentConfigsMock.configs.clear();
    activityMocks.getInstances.mockReset();
    activityMocks.getInstances.mockReturnValue([]);
    vi.clearAllMocks();
  });

  it("merges a settings override into persisted preferences", () => {
    expect(
      mergeAgentAwarenessRegistrationPreferences(
        { liveActivitiesEnabled: true, codeWordBreak: false },
        { liveActivitiesEnabled: false },
      ),
    ).toEqual({ liveActivitiesEnabled: false, codeWordBreak: false });
  });

  it("registers the APNs device through a paired environment", async () => {
    const environment = transport();
    setAgentAwarenessEnvironmentTransport(environment);

    await vi.waitFor(() => expect(environment.registerDevice).toHaveBeenCalledTimes(1));
    expect(environment.registerDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: "device-1",
        bundleId: "dev.schnau.t3code",
        apsEnvironment: "sandbox",
        pushToken: "apns-token",
      }),
    );
    expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
  });

  it("ends Live Activities when the last environment goes away but not on release", async () => {
    const environment = transport();
    setAgentAwarenessEnvironmentTransport(environment);
    await vi.waitFor(() => expect(environment.registerDevice).toHaveBeenCalledTimes(1));
    const activity = { end: vi.fn(() => Promise.resolve()) };
    activityMocks.getInstances.mockReturnValue([activity] as never);

    releaseAgentAwarenessEnvironmentTransport();
    expect(activity.end).not.toHaveBeenCalled();

    setAgentAwarenessEnvironmentTransport(null);
    expect(activity.end).toHaveBeenCalledWith("immediate");
  });

  it("reports missing server APNs credentials as a failed registration", async () => {
    const environment = transport({
      registerDevice: vi.fn(() =>
        Promise.resolve({ accepted: true as const, deliveryConfigured: false }),
      ),
    });
    setAgentAwarenessEnvironmentTransport(environment);

    await vi.waitFor(() => expect(getAgentAwarenessRegistrationStatus()).toBe("failed"));
  });

  it("registers an Android push token through the paired environment", async () => {
    vi.spyOn(Platform, "OS", "get").mockReturnValue("android");
    vi.spyOn(Platform, "Version", "get").mockReturnValue(36);
    vi.mocked(Notifications.getDevicePushTokenAsync).mockResolvedValue({
      type: "android",
      data: "fcm-token",
    });
    const environment = transport({ identity: "android-environment" });
    setAgentAwarenessEnvironmentTransport(environment);

    await vi.waitFor(() => expect(environment.registerDevice).toHaveBeenCalledTimes(1));
    expect(environment.registerDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "android",
        androidApiLevel: 36,
        pushToken: "fcm-token",
      }),
    );
    expect(configureAndroidAgentNotifications).toHaveBeenCalledWith(
      "device-1",
      "android-environment",
      true,
    );
    expect(clearAndroidAgentNotifications).not.toHaveBeenCalled();
    expect(getAgentAwarenessRegistrationStatus()).toBe("registered");
  });

  it.effect("surfaces missing APNs credentials as an actionable error", () => {
    const environment = transport({
      registerDevice: vi.fn(() =>
        Promise.resolve({ accepted: true as const, deliveryConfigured: false }),
      ),
    });
    setAgentAwarenessEnvironmentTransport(environment);

    return Effect.gen(function* () {
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(getAgentAwarenessRegistrationStatus()).toBe("failed")),
      );
      const error = yield* Effect.flip(
        updateAgentAwarenessRegistrationPreferences({ liveActivitiesEnabled: true }),
      );
      expect(error).toBeInstanceOf(AgentAwarenessDeliveryUnavailableError);
      expect((error as Error).message).toBe(
        "The paired server has no APNs provider credentials configured.",
      );
    });
  });

  it.effect("registers a Live Activity token with the paired environment", () => {
    const environment = transport();
    setAgentAwarenessEnvironmentTransport(environment);
    const activity = {
      getId: () => "activity-1",
      getPushToken: vi.fn(() => Promise.resolve("activity-token")),
      addPushTokenListener: vi.fn(),
    } as never;

    return Effect.gen(function* () {
      expect(yield* registerLiveActivityPushToken({ activity })).toBe(true);
      expect(environment.registerLiveActivity).toHaveBeenCalledWith({
        deviceId: "device-1",
        activityPushToken: "activity-token",
      });
    });
  });

  it.effect("registers a Live Activity push token that rotates after registration", () => {
    const environment = transport();
    setAgentAwarenessEnvironmentTransport(environment);
    let tokenListener: ((event: { readonly pushToken: string }) => void) | undefined;
    const activity = {
      getId: () => "activity-1",
      getPushToken: vi.fn(() => Promise.resolve("activity-token")),
      addPushTokenListener: vi.fn((listener: typeof tokenListener) => {
        tokenListener = listener;
        return { remove: vi.fn() };
      }),
    };

    return Effect.gen(function* () {
      expect(yield* registerLiveActivityPushToken({ activity: activity as never })).toBe(true);
      tokenListener?.({ pushToken: "rotated-activity-token" });
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(environment.registerLiveActivity).toHaveBeenCalledTimes(2)),
      );
      expect(
        vi.mocked(environment.registerLiveActivity).mock.calls.map(([input]) => input),
      ).toEqual([
        { deviceId: "device-1", activityPushToken: "activity-token" },
        { deviceId: "device-1", activityPushToken: "rotated-activity-token" },
      ]);
      expect(activity.addPushTokenListener).toHaveBeenCalledTimes(1);
    });
  });

  it("skips the Live Activity seed when the environment reports publishing disabled", async () => {
    environmentConfigsMock.configs.set("env-1", {
      environment: { capabilities: { agentActivityPublishing: false } },
    });

    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: "env-1" as EnvironmentId,
      threadTitle: "Fix the flaky test",
      projectTitle: "t3code",
    });

    expect(loadPreferences).not.toHaveBeenCalled();
    expect(activityMocks.start).not.toHaveBeenCalled();
  });

  it("seeds the Live Activity for publishing and pre-capability environments", async () => {
    environmentConfigsMock.configs.set("env-publishing", {
      environment: { capabilities: { agentActivityPublishing: true } },
    });

    vi.mocked(loadPreferences).mockResolvedValueOnce({
      liveActivitiesEnabled: true,
    } as Preferences);
    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: "env-publishing" as EnvironmentId,
      threadTitle: "Fix the flaky test",
      projectTitle: "t3code",
    });
    await vi.waitFor(() => expect(activityMocks.start).toHaveBeenCalledTimes(1));

    activityMocks.start.mockClear();
    vi.mocked(loadPreferences).mockResolvedValueOnce({
      liveActivitiesEnabled: true,
    } as Preferences);
    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: "env-pre-capability" as EnvironmentId,
      threadTitle: "Fix the flaky test",
      projectTitle: "t3code",
    });
    await vi.waitFor(() => expect(activityMocks.start).toHaveBeenCalledTimes(1));
  });

  describe("home-screen widget", () => {
    beforeEach(() => {
      // Most cases cover only the widget, so keep the Live Activity from priming.
      vi.mocked(loadPreferences).mockResolvedValue({ liveActivitiesEnabled: false } as Preferences);
    });

    const aggregate: RelayAgentActivityAggregateState = {
      title: "T3 Code",
      subtitle: "Agent work in progress",
      activeCount: 1,
      updatedAt: "2026-10-18T10:00:00.000Z",
      activities: [
        {
          environmentId: "env-1" as EnvironmentId,
          threadId: "thread-1" as ThreadId,
          projectTitle: "t3code",
          threadTitle: "Fix the widget",
          modelTitle: "GPT-5.5",
          phase: "running",
          status: "Working",
          updatedAt: "2026-10-18T10:00:00.000Z",
          deepLink: "/threads/env-1/thread-1",
        },
      ],
    };

    // Activation refreshes in the background and registers the device. Its snapshot read never
    // answers, so each case drives the reads it lists, in order.
    function activate(reads: ReadonlyArray<() => Promise<AgentAwarenessSnapshot>>) {
      let markActivationRead = () => {};
      const activationRead = new Promise<void>((resolve) => {
        markActivationRead = resolve;
      });
      let markRegistered = () => {};
      const registered = new Promise<void>((resolve) => {
        markRegistered = resolve;
      });
      const getSnapshot = vi.fn<() => Promise<AgentAwarenessSnapshot>>();
      getSnapshot.mockImplementationOnce(() => {
        markActivationRead();
        return new Promise(() => {});
      });
      for (const read of reads) {
        getSnapshot.mockImplementationOnce(read);
      }
      setAgentAwarenessEnvironmentTransport(
        transport({
          getSnapshot,
          registerDevice: vi.fn(() => {
            markRegistered();
            return Promise.resolve({ accepted: true as const, deliveryConfigured: true });
          }),
        }),
      );
      return Effect.promise(() => Promise.all([activationRead, registered]));
    }

    it.effect("publishes idle snapshots and keeps the last one when a read fails", () =>
      Effect.gen(function* () {
        yield* activate([
          () => Promise.resolve({ aggregate }),
          () => Promise.resolve({ aggregate: null }),
          () => Promise.reject(new Error("offline")),
        ]);

        yield* refreshActiveLiveActivityRemoteRegistration();
        yield* refreshActiveLiveActivityRemoteRegistration();
        yield* refreshActiveLiveActivityRemoteRegistration();

        expect(publishWidgetMock.mock.calls).toEqual([
          [{ kind: "snapshot", aggregate }],
          [{ kind: "snapshot", aggregate: null }],
        ]);
      }),
    );

    it.effect("keeps the newest rows when an older overlapping read finishes last", () =>
      Effect.gen(function* () {
        const newer = { ...aggregate, activeCount: 2 };
        let markOlderRequested = () => {};
        const olderRequested = new Promise<void>((resolve) => {
          markOlderRequested = resolve;
        });
        let answerOlder = (_snapshot: AgentAwarenessSnapshot) => {};
        yield* activate([
          () => {
            markOlderRequested();
            return new Promise((resolve) => {
              answerOlder = resolve;
            });
          },
          () => Promise.resolve({ aggregate: newer }),
        ]);

        const older = yield* Effect.forkChild(refreshActiveLiveActivityRemoteRegistration());
        yield* Effect.promise(() => olderRequested);
        yield* refreshActiveLiveActivityRemoteRegistration();
        answerOlder({ aggregate });
        yield* Fiber.join(older);

        expect(publishWidgetMock.mock.calls).toEqual([[{ kind: "snapshot", aggregate: newer }]]);
      }),
    );

    it.effect("does not prime a Live Activity from a read a newer one replaced", () =>
      Effect.gen(function* () {
        yield* activate([
          () => Promise.resolve({ aggregate }),
          () => Promise.resolve({ aggregate: { ...aggregate, activeCount: 0, activities: [] } }),
        ]);
        let markPreferencesRequested = () => {};
        const preferencesRequested = new Promise<void>((resolve) => {
          markPreferencesRequested = resolve;
        });
        let resolvePreferences = (_preferences: Preferences) => {};
        vi.mocked(loadPreferences).mockImplementationOnce(() => {
          markPreferencesRequested();
          return new Promise((resolve) => {
            resolvePreferences = resolve;
          });
        });

        const older = yield* Effect.forkChild(refreshActiveLiveActivityRemoteRegistration());
        yield* Effect.promise(() => preferencesRequested);
        yield* refreshActiveLiveActivityRemoteRegistration();
        resolvePreferences({ liveActivitiesEnabled: true } as Preferences);
        yield* Fiber.join(older);

        expect(activityMocks.start).not.toHaveBeenCalled();
      }),
    );
  });
});

describe("removing a paired environment", () => {
  it("asks that environment to forget this device", async () => {
    const unregister = vi.fn(() => Promise.resolve());

    await unregisterAgentAwarenessDeviceFromEnvironment(unregister);

    expect(unregister).toHaveBeenCalledWith("device-1");
  });

  it("does not block removal when the environment rejects or never answers", async () => {
    await expect(
      unregisterAgentAwarenessDeviceFromEnvironment(() => Promise.reject(new Error("offline"))),
    ).resolves.toBeUndefined();

    vi.useFakeTimers();
    try {
      const removal = unregisterAgentAwarenessDeviceFromEnvironment(() => new Promise(() => {}));
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(removal).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
