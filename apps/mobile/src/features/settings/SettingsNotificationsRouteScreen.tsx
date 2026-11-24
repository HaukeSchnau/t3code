import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { useGT, useMessages } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState, useSyncExternalStore } from "react";
import { Linking, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { m as resolveMessage } from "../../i18n/messages";

import {
  isAtomCommandInterrupted,
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import {
  openAndroidLiveUpdateSettings,
  supportsAndroidLiveUpdateSettings,
} from "../agent-awareness/androidNotifications";
import { setLiveActivityUpdatesEnabled } from "../agent-awareness/liveActivityPreferences";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import {
  agentAwarenessNotificationsReady,
  getAgentAwarenessRegistrationStatus,
  refreshAgentAwarenessRegistration,
  subscribeAgentAwarenessRegistrationStatus,
} from "../agent-awareness/remoteRegistration";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { resolveAgentAwarenessPlatformPresentation } from "./SettingsRouteScreen.logic";

const saveLocalPreference = (liveActivitiesEnabled: boolean) =>
  saveMobilePreferences.run(appAtomRegistry, { liveActivitiesEnabled });

type NotificationStatus = "checking" | "enabled" | "disabled" | "unsupported";
type LiveActivityStatus = "checking" | "enabled" | "disabled" | "updating";

const notificationStatusAtom = makePermissionStatusAtom<NotificationStatus>({
  label: "mobile:notification-permission",
  initial: "checking",
  read: async () => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") return "unsupported";
    const result = await settlePromise(() => Notifications.getPermissionsAsync());
    if (result._tag === "Failure") {
      reportAtomCommandResult(result, { label: "notification permission refresh" });
      return "disabled";
    }
    return result.value.granted ? "enabled" : "disabled";
  },
});

function liveActivityStatusFrom(
  preferencesResult: AsyncResult.AsyncResult<{ readonly liveActivitiesEnabled?: boolean }, unknown>,
): LiveActivityStatus {
  if (AsyncResult.isFailure(preferencesResult)) return "enabled";
  if (!AsyncResult.isSuccess(preferencesResult)) return "checking";
  return preferencesResult.value.liveActivitiesEnabled === false ? "disabled" : "enabled";
}

function useDeviceRegistered(): boolean {
  const status = useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    getAgentAwarenessRegistrationStatus,
    () => "unknown" as const,
  );
  return status === "registered";
}

function useNotificationsReady(): boolean {
  return useSyncExternalStore(
    subscribeAgentAwarenessRegistrationStatus,
    agentAwarenessNotificationsReady,
    () => false,
  );
}

export function SettingsNotificationsRouteScreen() {
  const gt = useGT();
  const m = useMessages();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const agentAwarenessPushAvailable = supportsAgentAwarenessPush();
  const agentAwarenessPlatform = resolveAgentAwarenessPlatformPresentation(Platform.OS, m);
  const agentAwarenessSubtitle =
    Platform.OS === "android" && !agentAwarenessPushAvailable
      ? gt("Install a newer app build to enable notifications")
      : agentAwarenessPlatform.subtitle;
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const notificationStatus = useAtomValue(notificationStatusAtom);
  const setNotificationStatus = useAtomSet(notificationStatusAtom);
  // A write in progress or a failed one shows its own status until the preference state it was
  // based on changes.
  const [liveActivityOverride, setLiveActivityOverride] = useState<{
    readonly status: LiveActivityStatus;
    readonly preferencesResult: unknown;
  } | null>(null);
  const liveActivityStatus =
    liveActivityOverride !== null && liveActivityOverride.preferencesResult === preferencesResult
      ? liveActivityOverride.status
      : liveActivityStatusFrom(preferencesResult);
  const setLiveActivityStatus = (status: LiveActivityStatus) =>
    setLiveActivityOverride({ status, preferencesResult });
  const deviceRegistered = useDeviceRegistered();
  const liveActivityWriteInFlight = useRef(false);
  const notificationsReady = useNotificationsReady();
  const liveActivitiesPreferenceEnabled = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value.liveActivitiesEnabled !== false
    : true;

  const environmentCount = Object.values(savedConnectionsById).filter(
    (connection) => connection.relayManaged !== true,
  ).length;
  const hasPairedEnvironment = environmentCount > 0;

  const requestNotifications = async () => {
    if (!hasPairedEnvironment) {
      Dialog.alert(
        gt("Pair an environment first"),
        gt("Notifications are delivered by a paired {product} server.", { product: "T3 Code" }),
      );
      return;
    }
    const result = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        requestAgentNotificationPermission.pipe(
          Effect.tap((permission) =>
            permission.type === "granted" ? refreshAgentAwarenessRegistration() : Effect.void,
          ),
        ),
      ),
    );
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Dialog.alert(
          gt("Notifications unavailable"),
          error instanceof Error
            ? (errorDisplayMessage(error, resolveMessage) ?? error.message)
            : gt("Could not request notification permission."),
        );
      }
      return;
    }
    if (result.value.type === "granted") {
      setNotificationStatus("enabled");
      if (!agentAwarenessNotificationsReady()) {
        Dialog.alert(
          gt("Couldn't finish enabling notifications"),
          gt(
            "Notification access was granted, but the paired server could not accept this device. Check its APNs provider configuration.",
          ),
        );
      }
      return;
    }
    if (result.value.type === "unsupported") {
      setNotificationStatus("unsupported");
      Dialog.alert(
        gt("Notifications unavailable"),
        gt("Agent notifications are unavailable on this platform."),
      );
      return;
    }
    setNotificationStatus("disabled");
    if (result.value.canAskAgain) {
      Dialog.alert(gt("Notifications disabled"), gt("Notifications were not enabled."));
      return;
    }
    Dialog.alert(
      gt("Notifications disabled"),
      gt("Notifications were denied for this app. Open Settings to enable them."),
      [
        { text: gt("Cancel"), style: "cancel" },
        { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
      ],
    );
  };

  const updateLiveActivities = async (enabled: boolean) => {
    if (enabled && !hasPairedEnvironment) {
      Dialog.alert(
        gt("Pair an environment first"),
        gt("Live Activity updates are delivered by a paired {product} server.", {
          product: "T3 Code",
        }),
      );
      return;
    }
    setLiveActivityStatus("updating");
    const updateResult = await settleAsyncResult(() =>
      runtime.runPromiseExit(
        setLiveActivityUpdatesEnabled({
          saveLocalPreference,
          enabled,
          previousEnabled: liveActivitiesPreferenceEnabled,
        }),
      ),
    );
    if (updateResult._tag === "Failure") {
      setLiveActivityStatus(liveActivitiesPreferenceEnabled ? "enabled" : "disabled");
      if (!isAtomCommandInterrupted(updateResult)) {
        const error = squashAtomCommandFailure(updateResult);
        Dialog.alert(
          gt("Live Activities unavailable"),
          error instanceof Error
            ? (errorDisplayMessage(error, resolveMessage) ?? error.message)
            : gt("Could not enable Live Activity updates."),
        );
      }
      return;
    }

    setLiveActivityStatus(enabled ? "enabled" : "disabled");
    if (enabled && getAgentAwarenessRegistrationStatus() !== "registered") {
      Dialog.alert(
        gt("Couldn't finish enabling Live Activities"),
        gt(
          "The paired server could not accept this device. Check its APNs provider configuration.",
        ),
      );
    }
  };

  const handleDeviceNotificationsChange = (enabled: boolean) => {
    if (enabled) {
      void requestNotifications();
      return;
    }

    Dialog.alert(
      gt("Disable notifications"),
      gt(
        "Notification permission is controlled by the operating system. Open Settings to disable notifications for {product}.",
        { product: "T3 Code" },
      ),
      [
        { text: gt("Cancel"), style: "cancel" },
        { text: gt("Open Settings"), onPress: () => void Linking.openSettings() },
      ],
    );
  };

  const handleLiveActivitiesChange = async (enabled: boolean) => {
    if (liveActivityWriteInFlight.current) return;
    liveActivityWriteInFlight.current = true;
    await updateLiveActivities(enabled);
    liveActivityWriteInFlight.current = false;
  };

  return (
    <SettingsScreen title={gt("Notifications")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title={gt("Agent activity")}>
          <SettingsSwitchRow
            icon="bell.badge"
            label={gt("Device Notifications")}
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              !hasPairedEnvironment ||
              notificationStatus === "checking" ||
              notificationStatus === "unsupported"
            }
            subtitle={agentAwarenessSubtitle}
            value={
              agentAwarenessPushAvailable && notificationStatus === "enabled" && notificationsReady
            }
            onValueChange={handleDeviceNotificationsChange}
          />
          <SettingsSwitchRow
            disabled={
              !agentAwarenessPlatform.supported ||
              !agentAwarenessPushAvailable ||
              !hasPairedEnvironment ||
              liveActivityStatus === "checking" ||
              liveActivityStatus === "updating"
            }
            icon="bolt.circle"
            label={
              Platform.OS === "android"
                ? supportsAndroidLiveUpdateSettings()
                  ? gt("Agent Live Updates")
                  : gt("Ongoing Agent Activity")
                : gt("Live Activity Updates")
            }
            subtitle={agentAwarenessSubtitle}
            value={
              agentAwarenessPushAvailable &&
              (liveActivityStatus === "enabled" || liveActivityStatus === "updating") &&
              deviceRegistered
            }
            onValueChange={(enabled) => void handleLiveActivitiesChange(enabled)}
          />
          {supportsAndroidLiveUpdateSettings() ? (
            <SettingsRow
              icon="bolt.circle"
              label={gt("Live Update Settings")}
              onPress={() => {
                void openAndroidLiveUpdateSettings().catch(() => {
                  Dialog.alert(
                    gt("Couldn't open Settings"),
                    gt(
                      "Open Android Settings, select {product}, then enable Live Updates in Notifications.",
                      { product: "T3 Code" },
                    ),
                  );
                });
              }}
            />
          ) : null}
        </SettingsSection>
      </ScrollView>
    </SettingsScreen>
  );
}
