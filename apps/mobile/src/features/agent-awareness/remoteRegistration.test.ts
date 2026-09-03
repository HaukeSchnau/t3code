import { beforeEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { EnvironmentId } from "@t3tools/contracts";
import type { Preferences } from "../../persistence/mobile-preferences";
import type { AgentAwarenessEnvironmentTransport } from "./remoteRegistration";
import {
  __resetAgentAwarenessRemoteRegistrationForTest,
  AgentAwarenessDeliveryUnavailableError,
  armAgentAwarenessLiveActivityForLocalWork,
  getAgentAwarenessRegistrationStatus,
  mergeAgentAwarenessRegistrationPreferences,
  registerLiveActivityPushToken,
  setAgentAwarenessEnvironmentTransport,
  updateAgentAwarenessRegistrationPreferences,
} from "./remoteRegistration";

const activityMocks = vi.hoisted(() => ({
  getInstances: vi.fn(() => []),
  start: vi.fn(() => ({})),
  updateSnapshot: vi.fn(),
}));
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

vi.mock("expo-notifications", () => ({
  addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
  getDevicePushTokenAsync: vi.fn(() => Promise.resolve({ type: "ios", data: "apns-token" })),
  getPermissionsAsync: vi.fn(() => Promise.resolve({ granted: true })),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "27.0" },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock("../../widgets/AgentActivity", () => ({
  default: {
    getInstances: activityMocks.getInstances,
    start: activityMocks.start,
  },
  AgentActivityWidget: { updateSnapshot: activityMocks.updateSnapshot },
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
    runPromiseExit: (operation: Effect.Effect<unknown, unknown>) =>
      Effect.runPromiseExit(operation),
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
    unregisterDevice: vi.fn(() => Promise.resolve()),
    registerLiveActivity: vi.fn(() =>
      Promise.resolve({ accepted: true as const, deliveryConfigured: true }),
    ),
    getSnapshot: vi.fn(() => Promise.resolve({ aggregate: null })),
    ...overrides,
  };
}

describe("accountless agent awareness registration", () => {
  beforeEach(() => {
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

  it("reports missing server APNs credentials as a failed registration", async () => {
    const environment = transport({
      registerDevice: vi.fn(() =>
        Promise.resolve({ accepted: true as const, deliveryConfigured: false }),
      ),
    });
    setAgentAwarenessEnvironmentTransport(environment);

    await vi.waitFor(() => expect(getAgentAwarenessRegistrationStatus()).toBe("failed"));
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

  it("skips the Live Activity seed when the environment reports publishing disabled", async () => {
    const { loadPreferences } = await import("../../persistence/imperative");
    vi.mocked(loadPreferences).mockResolvedValueOnce({
      liveActivitiesEnabled: true,
    } as Preferences);
    environmentConfigsMock.configs.set("env-1", {
      environment: { capabilities: { agentActivityPublishing: false } },
    });

    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: "env-1" as EnvironmentId,
      threadTitle: "Fix the flaky test",
      projectTitle: "t3code",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(activityMocks.start).not.toHaveBeenCalled();
  });

  it("seeds the Live Activity for publishing and pre-capability environments", async () => {
    const { loadPreferences } = await import("../../persistence/imperative");
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activityMocks.start).toHaveBeenCalledTimes(1);

    activityMocks.start.mockClear();
    vi.mocked(loadPreferences).mockResolvedValueOnce({
      liveActivitiesEnabled: true,
    } as Preferences);
    armAgentAwarenessLiveActivityForLocalWork({
      environmentId: "env-pre-capability" as EnvironmentId,
      threadTitle: "Fix the flaky test",
      projectTitle: "t3code",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activityMocks.start).toHaveBeenCalledTimes(1);
  });
});
