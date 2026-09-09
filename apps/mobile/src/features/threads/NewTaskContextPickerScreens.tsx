import { useArchivedThreadSnapshots } from "../archive/useArchivedThreadSnapshots";
import {
  filterWorkspaceGroups,
  withArchivedWorkspaces,
} from "@t3tools/client-runtime/state/workspaces";
import type { VcsRef } from "@t3tools/client-runtime/state/vcs";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react-native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Haptics from "expo-haptics";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { cn } from "../../lib/cn";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useServerConfigs } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { branchBadgeLabel, useNewTaskFlow } from "./new-task-flow-provider";
import { checkoutNewTaskBranch } from "./checkout-new-task-branch";

function SelectionRow(props: {
  readonly icon?: "arrow.triangle.branch" | ReactNode;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected: boolean;
  readonly isLast?: boolean;
  readonly subtitle?: string;
  readonly title: string;
}) {
  return (
    <Pressable
      accessibilityLabel={[props.title, props.subtitle].filter(Boolean).join(", ")}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      {props.icon === "arrow.triangle.branch" ? (
        <SymbolView
          name="arrow.triangle.branch"
          size={17}
          tintColorClassName={"accent-icon-muted"}
          type="monochrome"
        />
      ) : (
        (props.icon ?? null)
      )}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={16}
          tintColorClassName={"accent-icon"}
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}

function ToggleRow(props: {
  readonly title: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
}) {
  return (
    <View className="min-h-14 flex-row items-center gap-3 bg-card px-4 py-3">
      <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground" numberOfLines={1}>
        {props.title}
      </Text>
      <ThemedSwitch
        accessibilityLabel={props.title}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </View>
  );
}

function BranchSelectionRow(props: {
  readonly badge: string | null;
  readonly branch: VcsRef;
  readonly disabled: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onSelect: (branch: VcsRef) => void;
  readonly selected: boolean;
}) {
  const onPress = useCallback(() => props.onSelect(props.branch), [props.branch, props.onSelect]);

  return (
    <View
      className={cn(
        props.isFirst && "overflow-hidden rounded-t-2xl",
        props.isLast && "overflow-hidden rounded-b-2xl",
      )}
    >
      <SelectionRow
        icon="arrow.triangle.branch"
        disabled={props.disabled}
        isLast={props.isLast}
        onPress={onPress}
        selected={props.selected}
        subtitle={props.badge ? props.badge.toUpperCase() : undefined}
        title={props.branch.name}
      />
    </View>
  );
}

function PickerSurface(props: { readonly children: ReactNode }) {
  return <View className="overflow-hidden rounded-2xl bg-card">{props.children}</View>;
}

export function NewTaskWorkspacePickerRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [showSettled, setShowSettled] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const archiveEnvironmentIds = useMemo(
    () =>
      flow.selectedProject && (showSettled || query.trim())
        ? [flow.selectedProject.environmentId]
        : [],
    [flow.selectedProject, showSettled, query],
  );
  const archive = useArchivedThreadSnapshots(archiveEnvironmentIds);
  const workspaces = useMemo(
    () =>
      filterWorkspaceGroups(
        withArchivedWorkspaces(flow.workspaces, archive.snapshots, flow.selectedProject?.id ?? ""),
        { query, showSettled },
      ),
    [flow.workspaces, archive.snapshots, flow.selectedProject?.id, query, showSettled],
  );
  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions
        options={{ headerShown: Platform.OS !== "android", title: "Workspace" }}
      />
      {Platform.OS === "android" && (
        <AndroidScreenHeader title="Workspace" onBack={() => navigation.goBack()} />
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          padding: 16,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          gap: 16,
        }}
      >
        <PickerSurface>
          <SelectionRow
            title="New workspace"
            subtitle={
              flow.isolatedWorkspaces
                ? "Separate files, tools and services"
                : "A separate checkout for this task"
            }
            selected={flow.workspaceMode === "worktree"}
            onPress={() => {
              flow.setWorkspaceMode("worktree");
              navigation.goBack();
            }}
          />
          <SelectionRow
            title="Project checkout"
            selected={flow.workspaceMode === "local" && !flow.selectedWorktreePath}
            onPress={() => {
              flow.setWorkspaceMode("local");
              navigation.goBack();
            }}
            isLast
          />
        </PickerSurface>
        {
          <>
            <TextInput
              accessibilityLabel="Find workspace"
              placeholder="Find workspace…"
              value={query}
              onChangeText={setQuery}
              className="rounded-xl bg-card px-4 py-3 text-base text-foreground"
              autoCorrect={false}
            />
            {archive.isLoading && (
              <Text className="px-4 text-sm text-foreground-muted">
                Loading settled workspaces…
              </Text>
            )}
            {archive.error && (
              <Text className="px-4 text-sm text-foreground-muted">{archive.error}</Text>
            )}
            <PickerSurface>
              {workspaces.map((workspace, index) => (
                <SelectionRow
                  key={workspace.key}
                  title={workspace.label}
                  subtitle={`${workspace.threads.length} ${workspace.threads.length === 1 ? "thread" : "threads"}${workspace.runningCount > 0 ? ` · ${workspace.runningCount} running` : workspace.settled ? " · Settled" : ""}`}
                  selected={flow.selectedWorktreePath === workspace.checkoutPath}
                  onPress={() => {
                    flow.selectWorkspace(workspace);
                    navigation.goBack();
                  }}
                  isLast={index === workspaces.length - 1}
                />
              ))}
              {workspaces.length === 0 && (
                <Text className="p-4 text-sm text-foreground-muted">No matching workspaces.</Text>
              )}
            </PickerSurface>
            <PickerSurface>
              <ToggleRow title="Show settled" value={showSettled} onValueChange={setShowSettled} />
            </PickerSurface>
          </>
        }
        {flow.isolatedWorkspaces && (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={() => setAdvanced(!advanced)}
              className="px-4 py-2"
            >
              <Text className="text-sm text-foreground-muted">
                {advanced ? "Hide advanced" : "Advanced"}
              </Text>
            </Pressable>
            {advanced && (
              <Text className="px-4 text-sm text-foreground-muted">Applies to new workspaces.</Text>
            )}
            {advanced && (
              <PickerSurface>
                {(["familiar", "minimal"] as const).map((profile) => (
                  <SelectionRow
                    key={profile}
                    title={profile === "familiar" ? "Familiar" : "Minimal"}
                    subtitle={
                      profile === "familiar"
                        ? "Keep your global instructions and skills"
                        : "Use the project’s instructions and tools"
                    }
                    selected={flow.workspaceProfile === profile}
                    onPress={() => flow.setWorkspaceProfile(profile)}
                    isLast={profile === "minimal"}
                  />
                ))}
              </PickerSurface>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

export function NewTaskEnvironmentPickerRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const serverConfigs = useServerConfigs();

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          title: "Environment",
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title="Environment" onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          paddingHorizontal: 16,
          paddingTop: 16,
        }}
        showsVerticalScrollIndicator={false}
      >
        <PickerSurface>
          {flow.environments.map((environment, index) => (
            <SelectionRow
              key={String(environment.environmentId)}
              icon={
                <EnvironmentMachineSymbol
                  kind={resolveEnvironmentMachineKind(
                    serverConfigs.get(environment.environmentId) ?? null,
                  )}
                  size={17}
                  tintColorClassName="accent-icon-muted"
                />
              }
              isLast={index === flow.environments.length - 1}
              onPress={() => {
                void Haptics.selectionAsync();
                flow.selectEnvironment(environment.environmentId);
                navigation.goBack();
              }}
              selected={flow.selectedEnvironmentId === environment.environmentId}
              title={environment.environmentLabel}
            />
          ))}
        </PickerSurface>
      </ScrollView>
    </View>
  );
}

export function NewTaskBranchPickerRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const switchRef = useAtomCommand(vcsEnvironment.switchRef, { reportFailure: false });
  const [switchingBranchName, setSwitchingBranchName] = useState<string | null>(null);
  const selectingBranchNameRef = useRef<string | null>(null);
  const allowSelectionNavigationRef = useRef(false);
  const mountedRef = useRef(true);
  const screenTitle = flow.workspaceMode === "worktree" ? "Base branch" : "Branch";
  const usesNativeMailSearchToolbar = Platform.OS === "ios" && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;
  const selectedBranchName =
    flow.selectedBranchName ??
    flow.availableBranches.find((branch) => branch.current)?.name ??
    flow.availableBranches.find((branch) => branch.isDefault)?.name ??
    null;
  const branchListContentStyle = useMemo(
    () => ({
      paddingBottom: usesNativeMailSearchToolbar
        ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET + 16
        : Platform.OS === "ios"
          ? 16
          : Math.max(insets.bottom, 16) + 16,
      paddingHorizontal: 16,
      paddingTop: 12,
    }),
    [insets.bottom, usesNativeMailSearchToolbar],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flow.setBranchQuery("");
    };
  }, [flow.setBranchQuery]);

  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (selectingBranchNameRef.current !== null && !allowSelectionNavigationRef.current) {
          event.preventDefault();
        }
      }),
    [navigation],
  );

  const selectBranch = useCallback(
    async (branch: VcsRef) => {
      if (selectingBranchNameRef.current !== null) {
        return;
      }
      selectingBranchNameRef.current = branch.name;
      void Haptics.selectionAsync();

      try {
        if (!flow.selectedProject) return;
        setSwitchingBranchName(branch.name);
        const result = await checkoutNewTaskBranch({
          branch,
          project: {
            ...flow.selectedProject,
            workspaceRoot: flow.selectedWorktreePath ?? flow.selectedProject.workspaceRoot,
          },
          workspaceMode: flow.workspaceMode,
          switchRef,
        });
        if (result._tag === "Failure") {
          if (mountedRef.current && navigation.isFocused() && !isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            Alert.alert(
              "Could not switch branch",
              error instanceof Error ? error.message : "The branch could not be checked out.",
            );
          }
          return;
        }

        // The checkout has already changed the repository. Persist the matching
        // draft selection even if the native sheet was dismissed while the
        // command was in flight; only visible-screen work is focus-gated below.
        flow.selectBranch(result.value);
        if (!mountedRef.current || !navigation.isFocused()) {
          return;
        }
        flow.setBranchQuery("");
        allowSelectionNavigationRef.current = true;
        navigation.goBack();
      } finally {
        selectingBranchNameRef.current = null;
        allowSelectionNavigationRef.current = false;
        if (mountedRef.current) {
          setSwitchingBranchName(null);
        }
      }
    },
    [
      flow.selectBranch,
      flow.selectedProject,
      flow.selectedWorktreePath,
      flow.setBranchQuery,
      flow.workspaceMode,
      navigation,
      switchRef,
    ],
  );

  const renderBranch = useCallback(
    ({ item, index }: { readonly item: VcsRef; readonly index: number }) => (
      <BranchSelectionRow
        badge={branchBadgeLabel({ branch: item, project: flow.selectedProject })}
        branch={item}
        disabled={switchingBranchName !== null}
        isFirst={index === 0}
        isLast={index === flow.filteredBranches.length - 1}
        onSelect={selectBranch}
        selected={selectedBranchName === item.name}
      />
    ),
    [
      flow.filteredBranches.length,
      flow.selectedProject,
      flow.selectedWorktreePath,
      selectBranch,
      selectedBranchName,
      switchingBranchName,
    ],
  );

  const branchListHeader =
    flow.workspaceMode === "worktree" ? (
      <View className="mb-3 overflow-hidden rounded-2xl">
        <ToggleRow
          onValueChange={flow.setStartFromOrigin}
          title="Start from origin"
          value={flow.startFromOrigin}
        />
      </View>
    ) : null;

  const branchContent =
    flow.filteredBranches.length === 0 ? (
      <ScrollView
        className="flex-1 bg-sheet"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 16, paddingTop: 12 }}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
      >
        {branchListHeader}
        <View
          className="flex-1 items-center justify-center gap-3 px-4"
          style={{
            marginBottom: usesNativeMailSearchToolbar
              ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET
              : 0,
          }}
        >
          {flow.branchesLoading ? <ActivityIndicator /> : null}
          <Text className="text-center text-sm text-foreground-muted">
            {flow.branchesLoading
              ? "Loading branches…"
              : flow.branchesError
                ? flow.branchesError
                : flow.branchQuery
                  ? "No matching branches"
                  : "No branches available"}
          </Text>
          {!flow.branchesLoading && flow.branchesError ? (
            <Pressable
              accessibilityRole="button"
              className="rounded-full bg-card px-4 py-2 active:opacity-70"
              onPress={flow.loadBranches}
            >
              <Text className="text-sm font-t3-medium text-foreground">Try again</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    ) : (
      <LegendList
        alwaysBounceVertical={false}
        automaticallyAdjustsScrollIndicatorInsets
        automaticallyAdjustKeyboardInsets={Platform.OS === "ios"}
        className="flex-1 bg-sheet"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={branchListContentStyle}
        data={flow.filteredBranches}
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(branch) =>
          `${branch.remoteName ?? "local"}:${branch.name}:${branch.worktreePath ?? ""}`
        }
        ListHeaderComponent={branchListHeader}
        ListFooterComponent={
          flow.branchesFetchingNextPage ? (
            <View className="items-center py-4">
              <ActivityIndicator />
            </View>
          ) : null
        }
        onEndReached={flow.hasMoreBranches ? flow.loadMoreBranches : undefined}
        onEndReachedThreshold={0.35}
        renderItem={renderBranch}
        showsVerticalScrollIndicator={false}
      />
    );

  if (Platform.OS === "android") {
    return (
      <View className="flex-1 bg-sheet" collapsable={false}>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <AndroidScreenHeader title={screenTitle} onBack={() => navigation.goBack()} />
        <View className="px-4 pb-2 pt-3">
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            className="h-11 rounded-xl bg-card px-4 font-sans text-base text-foreground"
            onChangeText={flow.setBranchQuery}
            placeholder="Find a branch"
            placeholderTextColorClassName={"accent-placeholder"}
            value={flow.branchQuery}
          />
        </View>
        {branchContent}
      </View>
    );
  }

  return (
    <>
      <NativeStackScreenOptions
        options={{
          headerShown: true,
          title: screenTitle,
          unstable_headerToolbarItems: usesNativeMailSearchToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  onSearchTextChange: flow.setBranchQuery,
                  placeholder: "Find a branch",
                  searchTextChangeId: "new-task-branch-search-text",
                  showsSearchDismissButton: true,
                }),
              ]
            : undefined,
          headerSearchBarOptions: usesNativeMailSearchToolbar
            ? undefined
            : {
                allowToolbarIntegration: true,
                autoCapitalize: "none",
                hideNavigationBar: false,
                obscureBackground: false,
                placeholder: "Find a branch",
                onChangeText: (event) => {
                  flow.setBranchQuery(event.nativeEvent.text);
                },
                onCancelButtonPress: () => {
                  flow.setBranchQuery("");
                },
              },
        }}
      />
      {usesNativeMailSearchToolbar ? null : (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.SearchBarSlot />
        </NativeHeaderToolbar>
      )}
      {branchContent}
    </>
  );
}
