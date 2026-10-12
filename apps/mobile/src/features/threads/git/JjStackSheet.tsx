import type { JjStackRow } from "@t3tools/client-runtime/state/vcs";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Platform, RefreshControl, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { cn } from "../../../lib/cn";
import {
  NativeStackScreenOptions,
  nativeHeaderScrollEdgeEffects,
} from "../../../native/StackHeader";
import { useEnvironmentQuery } from "../../../state/query";
import { useSelectedThreadJjActions } from "../../../state/use-selected-thread-jj-actions";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useVcsActionState } from "../../../state/use-vcs-action-state";
import { vcsEnvironment } from "../../../state/vcs";
import { SheetActionButton } from "./gitSheetComponents";
import { jjBreadcrumb, jjPushState, jjStackViewFromStatus } from "./jj-stack-presentation";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);
const NativeScreen = withUniwind(Screen);
const NativeHeader = withUniwind(ScreenStackHeaderConfig, {
  color: { fromClassName: "tintColorClassName", styleProperty: "accentColor" },
  titleColor: { fromClassName: "titleColorClassName", styleProperty: "accentColor" },
});

type JjStackSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function JjStackSheet(props: JjStackSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const jjActions = useSelectedThreadJjActions();
  const actionTarget = useMemo(
    () => ({ environmentId: selectedThread?.environmentId ?? null, cwd: selectedThreadCwd }),
    [selectedThread?.environmentId, selectedThreadCwd],
  );
  const busy = useVcsActionState(actionTarget).isRunning;

  const status = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const view = useMemo(
    () => jjStackViewFromStatus(status.data, props.route.params.threadId),
    [props.route.params.threadId, status.data],
  );
  const title = view ? jjBreadcrumb(view) : "Stack";
  const subtitle = view ? jjPushState(view) : "Loading stack…";
  const pushTarget = view?.pushTarget ?? null;
  const canCommit = !busy && view?.workingCopy != null && !view.workingCopy.empty;

  const [commitMessage, setCommitMessage] = useState("");
  // Actions report through the thread's progress banner, so the sheet closes first.
  const commit = () => {
    const message = commitMessage.trim();
    navigation.goBack();
    void jjActions.commit(message);
  };
  const push = (createPr: boolean) => {
    if (pushTarget === null) return;
    navigation.goBack();
    void (createPr ? jjActions.createPr : jjActions.push)(pushTarget.changeId);
  };

  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const handlePullRefresh = async () => {
    setIsPullRefreshing(true);
    try {
      await jjActions.refresh();
    } finally {
      setIsPullRefreshing(false);
    }
  };

  const content = (
    <ScrollView
      alwaysBounceVertical
      className="flex-1 android:bg-sheet-solid ios:bg-screen"
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
      contentContainerStyle={{
        paddingHorizontal: Platform.OS === "android" ? 8 : 20,
        paddingTop: 8,
        gap: Platform.OS === "android" ? 8 : 14,
      }}
      refreshControl={
        <RefreshControl refreshing={isPullRefreshing} onRefresh={() => void handlePullRefresh()} />
      }
    >
      {view && view.rows.length > 0 ? (
        <View className="overflow-hidden bg-card android:rounded-[20px] ios:rounded-[22px] ios:border ios:border-border ios:px-4 ios:py-1">
          {view.rows.map((row, index) => (
            <View key={row.changeId}>
              {index > 0 && Platform.OS !== "android" ? (
                <View className="ml-7 h-px bg-border" />
              ) : null}
              <JjStackRowView row={row} />
            </View>
          ))}
        </View>
      ) : null}

      <View className="android:gap-3 android:rounded-[20px] android:bg-card android:p-4 ios:gap-2">
        <Text className="text-foreground android:text-base android:font-t3-medium ios:text-sm ios:font-t3-bold">
          Commit message
        </Text>
        <TextInput
          multiline
          accessibilityLabel="Commit message"
          value={commitMessage}
          onChangeText={setCommitMessage}
          placeholder="Leave empty to auto-generate"
          textAlignVertical="top"
          className="min-h-[96px] px-4 py-3.5 android:rounded-xl android:bg-sheet-solid ios:rounded-[20px]"
        />
        <View className="flex-row">
          <SheetActionButton
            icon="checkmark.circle"
            label="Commit"
            tone="primary"
            disabled={!canCommit}
            onPress={commit}
          />
        </View>
      </View>

      <View className="android:gap-2 ios:flex-row ios:gap-3">
        <View className="ios:flex-1">
          <SheetActionButton
            icon="arrow.up.circle"
            label="Push"
            disabled={busy || pushTarget === null}
            onPress={() => push(false)}
          />
        </View>
        <View className="ios:flex-1">
          <SheetActionButton
            icon="arrow.up.right.circle"
            label="Push & create PR"
            disabled={busy || pushTarget === null}
            onPress={() => push(true)}
          />
        </View>
      </View>
    </ScrollView>
  );

  if (Platform.OS === "ios") {
    // A form sheet renders no stack header, so the header comes from a nested native stack.
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <ScreenStack style={{ flex: 1 }}>
          <NativeScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="thread-jj-sheet-native"
            scrollEdgeEffects={HEADER_SCROLL_EDGE_EFFECTS}
            className="flex-1 bg-sheet"
          >
            {content}
            <NativeHeader
              backgroundColor="rgba(0,0,0,0)"
              tintColorClassName="accent-foreground"
              hideBackButton
              hideShadow={false}
              navigationItemStyle="editor"
              title={title}
              subtitle={subtitle}
              titleColorClassName="accent-foreground"
              titleFontSize={18}
              titleFontWeight="800"
              translucent
            />
          </NativeScreen>
        </ScreenStack>
      </View>
    );
  }

  return (
    <View collapsable={false} className="flex-1 bg-header">
      <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      <AndroidSheetHeader
        title={title}
        subtitle={subtitle}
        hideBottomBorder
        onBack={() => navigation.goBack()}
      />
      <MaterialScreenContent>{content}</MaterialScreenContent>
    </View>
  );
}

function JjStackRowView(props: { readonly row: JjStackRow }) {
  const { row } = props;
  return (
    <View className="flex-row items-start gap-3 py-3 android:px-4">
      <Text
        className={cn(
          "w-4 text-center font-mono text-sm",
          row.workingCopy ? "text-foreground" : "text-foreground-muted",
        )}
      >
        {row.workingCopy ? "@" : "○"}
      </Text>
      <View className="flex-1 gap-1">
        <Text
          numberOfLines={2}
          className={cn(
            "text-sm leading-snug",
            row.undescribed ? "text-foreground-muted" : "text-foreground font-t3-bold",
          )}
        >
          {row.title}
        </Text>
        <View className="flex-row flex-wrap items-center gap-2">
          <Text className="font-mono text-xs text-foreground-muted">{row.shortChangeId}</Text>
          {row.turnLabel ? (
            <View className="rounded-full bg-subtle px-2 py-0.5">
              <Text className="text-2xs font-t3-bold text-foreground-secondary">
                {row.turnLabel}
              </Text>
            </View>
          ) : null}
          {row.conflict ? (
            <Text className="text-2xs font-t3-bold text-warning-foreground">Conflict</Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}
