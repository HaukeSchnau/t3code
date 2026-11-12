import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { type FollowUpHome, groupFollowUps } from "@t3tools/client-runtime/state/follow-ups";
import type {
  EnvironmentId,
  FollowUp,
  FollowUpGardenerRun,
  FollowUpThreadRef,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import {
  allFollowUpsAtom,
  followUpEnvironment,
  followUpHomesAtom,
  openFollowUpsAtom,
} from "../../state/follow-ups";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { followUpRowDescription, formatFollowUpDate } from "./followUpPresentation";
import { useOpenFollowUp } from "./useOpenFollowUp";
import { failureMessage } from "./useStartFollowUpThread";

/** The Follow-ups workspace tab: each home's follow-ups by where they stand. */
export function FollowUpsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const openFollowUp = useOpenFollowUp();
  const selectDetail = useSelectWorkspaceDetail();
  const openThread = (thread: FollowUpThreadRef) =>
    selectDetail({
      name: "Thread",
      params: { environmentId: String(thread.environmentId), threadId: String(thread.threadId) },
    });
  const homes = useAtomValue(followUpHomesAtom);
  const environments = useWorkspaceEnvironments();
  const [showClosed, setShowClosed] = useState(false);
  const label = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)
      ?.environmentLabel ?? environmentId;
  const connectedHomes = homes.filter((home) => home.connected);

  return (
    <SettingsScreen
      title="Follow-ups"
      workspaceRoot
      actions={[
        {
          accessibilityLabel: "New follow-up",
          icon: "plus",
          disabled: connectedHomes.length === 0,
          onPress: () => navigation.navigate("FollowUpCapture"),
        },
      ]}
      menus={[
        {
          title: "Show follow-ups",
          icon: showClosed
            ? "line.3.horizontal.decrease.circle.fill"
            : "line.3.horizontal.decrease",
          items: [
            {
              id: "open",
              title: "Still to do",
              selected: !showClosed,
              onPress: () => setShowClosed(false),
            },
            {
              id: "closed",
              title: "Include closed",
              selected: showClosed,
              onPress: () => setShowClosed(true),
            },
          ],
        },
      ]}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {homes.length === 0 ? (
          <EmptyState
            variant="plain"
            title="No follow-ups here"
            detail="None of the connected environments keeps follow-ups."
          />
        ) : null}
        {homes.map((home) =>
          home.connected ? (
            <HomeFollowUps
              key={home.environmentId}
              home={home}
              title={connectedHomes.length > 1 ? label(home.environmentId) : null}
              showClosed={showClosed}
              onOpen={(followUp) =>
                openFollowUp({ homeEnvironmentId: home.environmentId, followUp })
              }
              onOpenThread={openThread}
            />
          ) : (
            <Text key={home.environmentId} className="px-2 text-sm text-foreground-muted">
              {label(home.environmentId)} keeps more follow-ups but isn't connected.
            </Text>
          ),
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function HomeFollowUps(props: {
  readonly home: FollowUpHome;
  /** Set when several homes are listed. */
  readonly title: string | null;
  readonly showClosed: boolean;
  readonly onOpen: (followUp: FollowUp) => void;
  readonly onOpenThread: (thread: FollowUpThreadRef) => void;
}) {
  const query = useEnvironmentQuery(
    props.showClosed
      ? allFollowUpsAtom(props.home.environmentId)
      : openFollowUpsAtom(props.home.environmentId),
  );
  const sections = query.data === null ? null : groupFollowUps(query.data.followUps);
  const groups = [
    { title: "Back now", followUps: sections?.backNow ?? [] },
    { title: "Open", followUps: sections?.open ?? [] },
    { title: "Picked up", followUps: sections?.pickedUp ?? [] },
    { title: "Closed", followUps: props.showClosed ? (sections?.closed ?? []) : [] },
  ].filter((group) => group.followUps.length > 0);

  return (
    <View className="gap-5">
      {props.title !== null ? (
        <Text textRole="headline" className="px-2 font-t3-bold text-foreground">
          {props.title}
        </Text>
      ) : null}
      {query.data === null ? (
        <Text className="px-2 text-base text-foreground-muted">
          {query.error ?? "Loading follow-ups…"}
        </Text>
      ) : groups.length === 0 ? (
        <EmptyState
          variant="plain"
          title="Nothing to follow up"
          detail="Agents add follow-ups when a thread leaves work for later."
        />
      ) : (
        groups.map((group) => (
          <SettingsSection key={group.title} title={group.title}>
            {group.followUps.map((followUp, index) => (
              <View
                key={followUp.id}
                className={index === 0 ? undefined : "border-t border-border-subtle"}
              >
                <ListRow
                  label={followUp.title}
                  description={followUpRowDescription(followUp)}
                  onPress={() => props.onOpen(followUp)}
                />
              </View>
            ))}
          </SettingsSection>
        ))
      )}
      {query.data !== null ? (
        <NightlyPass
          home={props.home.environmentId}
          lastRun={query.data.lastGardenerRun}
          onOpenThread={props.onOpenThread}
        />
      ) : null}
    </View>
  );
}

/** The gardener's nightly pass: when it last ran, its report, and a way to run it now. */
function NightlyPass(props: {
  readonly home: EnvironmentId;
  readonly lastRun: FollowUpGardenerRun | null;
  readonly onOpenThread: (thread: FollowUpThreadRef) => void;
}) {
  const canRun = useAtomValue(followUpEnvironment.runGardener.permissionAtom(props.home));
  const runGardener = useAtomCommand(followUpEnvironment.runGardener, {
    label: "follow-up nightly pass",
    reportFailure: false,
  });
  const [running, setRunning] = useState(false);
  const inFlight = useRef(false);
  const run = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    const result = await runGardener({ environmentId: props.home, input: {} });
    inFlight.current = false;
    setRunning(false);
    const message = failureMessage(result);
    if (message !== null) Dialog.alert("Could not start the nightly pass", message);
    if (result._tag === "Success") props.onOpenThread(result.value.thread);
  };
  const { lastRun } = props;
  return (
    <View className="gap-1">
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {lastRun === null
          ? "The nightly pass has not run yet."
          : `The nightly pass last ran ${formatFollowUpDate(lastRun.startedAt)}.`}
      </Text>
      <View className="-ml-3 flex-row flex-wrap">
        {lastRun !== null ? (
          <Button
            label="Open its report"
            tone="text"
            size="compact"
            onPress={() => props.onOpenThread(lastRun.thread)}
          />
        ) : null}
        <Button
          label="Run now"
          tone="text"
          size="compact"
          disabled={!canRun}
          loading={running}
          onPress={() =>
            Dialog.confirm({
              title: "Run the nightly pass now?",
              message: "An agent tidies these follow-ups in a new thread, as it does each night.",
              confirmText: "Run now",
              onConfirm: () => void run(),
            })
          }
        />
      </View>
    </View>
  );
}
