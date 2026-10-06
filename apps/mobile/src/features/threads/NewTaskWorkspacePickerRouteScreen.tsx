import { useAtomValue } from "@effect/atom-react";
import { projectWorkspaceGroups } from "@t3tools/client-runtime/state/workspaces";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig, useThreadShells } from "../../state/entities";
import { updateComposerDraftSettings } from "../../state/use-composer-drafts";
import { useArchivedThreadSnapshots } from "../archive/useArchivedThreadSnapshots";
import { managedWorkspacesFor, workspaceProfileAtom } from "./managed-workspaces";
import { PickerSurface, SelectionRow, ToggleRow } from "./NewTaskContextPickerScreens";
import { useNewTaskFlow } from "./new-task-flow-provider";

const EMPTY_ENVIRONMENT_IDS: ReadonlyArray<EnvironmentId> = [];

/**
 * Fork: choose a new workspace, the project checkout, or a workspace other
 * threads already use (patches/workspaces.md). Settled workspaces are found
 * through search or Show settled, which load archived threads on demand.
 */
export function NewTaskWorkspacePickerRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const project = flow.selectedProject;
  const config = useEnvironmentServerConfig(project?.environmentId ?? null);
  const managed = managedWorkspacesFor(config, project?.workspaceRoot);
  const profile = useAtomValue(workspaceProfileAtom);
  const [query, setQuery] = useState("");
  const [showSettled, setShowSettled] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const threads = useThreadShells();
  const archiveEnvironmentIds = useMemo(
    () =>
      project && (showSettled || query.trim().length > 0)
        ? [project.environmentId]
        : EMPTY_ENVIRONMENT_IDS,
    [project, showSettled, query],
  );
  const archive = useArchivedThreadSnapshots(archiveEnvironmentIds);
  const workspaces = useMemo(
    () =>
      project === null
        ? []
        : projectWorkspaceGroups({
            projectId: project.id,
            threads: threads.filter((thread) => thread.environmentId === project.environmentId),
            archived: archive.snapshots,
            query,
            showSettled,
          }),
    [project, threads, archive.snapshots, query, showSettled],
  );

  const selectWorkspace = (path: string, branch: string | null) => {
    if (flow.draftKey !== null) {
      updateComposerDraftSettings(flow.draftKey, {
        workspaceSelection: {
          mode: "local",
          branch,
          worktreePath: path,
          ...(flow.startFromOrigin ? { startFromOrigin: true } : {}),
        },
      });
    }
    navigation.goBack();
  };
  const isNew = flow.workspaceMode === "worktree";

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions
        options={{ headerShown: Platform.OS !== "android", title: "Workspace" }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title="Workspace" onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
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
              managed?.isolated
                ? "Separate files, tools and services"
                : "A separate copy for this task"
            }
            selected={isNew}
            onPress={() => {
              flow.setWorkspaceMode("worktree");
              navigation.goBack();
            }}
          />
          <SelectionRow
            title="Project checkout"
            selected={!isNew && flow.selectedWorktreePath === null}
            onPress={() => {
              if (flow.draftKey !== null) {
                updateComposerDraftSettings(flow.draftKey, {
                  workspaceSelection: {
                    mode: "local",
                    branch: null,
                    worktreePath: null,
                    ...(flow.startFromOrigin ? { startFromOrigin: true } : {}),
                  },
                });
              }
              navigation.goBack();
            }}
            isLast
          />
        </PickerSurface>
        <TextInput
          accessibilityLabel="Find workspace"
          placeholder="Find workspace…"
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          autoCapitalize="none"
          className="rounded-xl bg-grouped-card px-4 py-3 text-base text-foreground"
        />
        <PickerSurface>
          {workspaces.map((workspace, index) => (
            <SelectionRow
              key={workspace.key}
              title={workspace.label}
              subtitle={`${workspace.threadCount} ${workspace.threadCount === 1 ? "thread" : "threads"}${
                workspace.runningCount > 0
                  ? ` · ${workspace.runningCount} running`
                  : workspace.settled
                    ? " · Settled"
                    : ""
              }`}
              selected={!isNew && flow.selectedWorktreePath === workspace.path}
              onPress={() => selectWorkspace(workspace.path, workspace.branch)}
              isLast={index === workspaces.length - 1}
            />
          ))}
          {workspaces.length === 0 ? (
            <Text className="p-4 text-sm text-foreground-muted">
              {archive.isLoading
                ? "Loading settled workspaces…"
                : (archive.error ?? "No matching workspaces.")}
            </Text>
          ) : null}
        </PickerSurface>
        <PickerSurface>
          <ToggleRow title="Show settled" value={showSettled} onValueChange={setShowSettled} />
        </PickerSurface>
        {managed?.isolated ? (
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
            {advanced ? (
              <PickerSurface>
                {(["familiar", "minimal"] as const).map((value) => (
                  <SelectionRow
                    key={value}
                    title={value === "familiar" ? "Familiar" : "Minimal"}
                    subtitle={
                      value === "familiar"
                        ? "Keeps your global instructions and skills"
                        : "Starts with the project's own instructions and tools"
                    }
                    selected={profile === value}
                    onPress={() => appAtomRegistry.set(workspaceProfileAtom, value)}
                    isLast={value === "minimal"}
                  />
                ))}
              </PickerSurface>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}
