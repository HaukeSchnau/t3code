import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { iosPersonalTeamBuild: false } } },
}));

import {
  makeAgentAwarenessDeviceRegistrationInput,
  resolveApsEnvironment,
} from "./registrationPayload";

describe("agent awareness registration payload", () => {
  it("preserves APNs routing and notification preferences", () => {
    expect(
      makeAgentAwarenessDeviceRegistrationInput({
        deviceId: "device-1",
        label: "Hauke's iPhone",
        iosMajorVersion: 27,
        appVersion: "1.2.3",
        bundleId: "dev.schnau.t3code",
        apsEnvironment: "sandbox",
        pushToken: "apns-token",
        notificationsEnabled: true,
        preferences: { liveActivitiesEnabled: false },
      }),
    ).toEqual({
      deviceId: "device-1",
      label: "Hauke's iPhone",
      platform: "ios",
      iosMajorVersion: 27,
      appVersion: "1.2.3",
      bundleId: "dev.schnau.t3code",
      apsEnvironment: "sandbox",
      pushToken: "apns-token",
      preferences: {
        liveActivitiesEnabled: false,
        notificationsEnabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
    });
  });

  it("uses the signed build environment before the app-variant fallback", () => {
    expect(resolveApsEnvironment("sandbox", "production")).toBe("sandbox");
    expect(resolveApsEnvironment(undefined, "development")).toBe("sandbox");
    expect(resolveApsEnvironment(undefined, "production")).toBe("production");
  });
});
