import { useAtomValue } from "@effect/atom-react";
import { type FollowUpHome, groupFollowUps } from "@t3tools/client-runtime/state/follow-ups";
import type { EnvironmentId, FollowUp } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRow } from "../../components/ui/ListRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { allFollowUpsAtom, followUpHomesAtom, openFollowUpsAtom } from "../../state/follow-ups";
import { useEnvironmentQuery } from "../../state/query";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { followUpRowDescription } from "./followUpPresentation";
import { useOpenFollowUp } from "./useOpenFollowUp";

/** The Follow-ups workspace tab: each home's follow-ups by where they stand. */
export function FollowUpsScreen() {
  const insets = useSafeAreaInsets();
  const openFollowUp = useOpenFollowUp();
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
    </View>
  );
}
