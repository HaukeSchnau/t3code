import type { AgentAwarenessDeviceRegistrationInput } from "@t3tools/contracts";

import type { Preferences } from "../../persistence/mobile-preferences";
import { supportsAgentAwarenessPush } from "./capabilities";

// Local Xcode builds can use a production app variant while still being
// development-signed, so prefer the APNs environment captured by app.config.
// The variant fallback preserves compatibility with older updates.
export function resolveApsEnvironment(
  configuredEnvironment: unknown,
  appVariant: unknown,
): "sandbox" | "production" {
  if (configuredEnvironment === "sandbox" || configuredEnvironment === "production") {
    return configuredEnvironment;
  }
  return appVariant === "development" ? "sandbox" : "production";
}

export function makeAgentAwarenessDeviceRegistrationInput(input: {
  readonly deviceId: string;
  readonly label: string;
  readonly iosMajorVersion: number;
  readonly appVersion?: string;
  readonly bundleId?: string;
  readonly apsEnvironment?: "sandbox" | "production";
  readonly pushToken?: string;
  readonly pushToStartToken?: string;
  readonly notificationsEnabled: boolean;
  readonly preferences: Preferences;
}): AgentAwarenessDeviceRegistrationInput {
  const pushAvailable = supportsAgentAwarenessPush();
  const liveActivitiesEnabled = pushAvailable && input.preferences.liveActivitiesEnabled !== false;
  return {
    deviceId: input.deviceId,
    label: input.label,
    platform: "ios",
    iosMajorVersion: input.iosMajorVersion,
    appVersion: input.appVersion,
    ...(input.bundleId ? { bundleId: input.bundleId } : {}),
    ...(input.apsEnvironment ? { apsEnvironment: input.apsEnvironment } : {}),
    ...(input.pushToken ? { pushToken: input.pushToken } : {}),
    ...(input.pushToStartToken ? { pushToStartToken: input.pushToStartToken } : {}),
    preferences: {
      liveActivitiesEnabled,
      notificationsEnabled: pushAvailable && input.notificationsEnabled,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    },
  };
}
