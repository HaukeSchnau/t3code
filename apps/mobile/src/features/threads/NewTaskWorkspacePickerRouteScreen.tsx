import { useAtomValue } from "@effect/atom-react";
import { projectWorkspaceGroups } from "@t3tools/client-runtime/state/workspaces";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useGT } from "gt-react-native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShells } from "../../state/entities";
import { updateComposerDraftSettings } from "../../state/use-composer-drafts";
import { useArchivedThreadSnapshots } from "../archive/useArchivedThreadSnapshots";
import { workspaceIsolatedAtom, workspaceProfileAtom } from "./managed-workspaces";
import { SelectionRow } from "../../components/ui/SelectionRow";
import { PickerSurface, ToggleRow } from "./NewTaskContextPickerScreens";
import { useNewTaskFlow } from "./new-task-flow-provider";

const EMPTY_ENVIRONMENT_IDS: ReadonlyArray<EnvironmentId> = [];

/**
 * Choose a new workspace, the project checkout, or a workspace other
 * threads already use (patches/workspaces.md). Settled workspaces are found
 * through search or Show settled, which load archived threads on demand.
 */
export function NewTaskWorkspacePickerRouteScreen() {
  const gt = useGT();
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const project = flow.selectedProject;
  const managed = flow.managedWorkspaces;
  const profile = useAtomValue(workspaceProfileAtom);
  const isolated = useAtomValue(workspaceIsolatedAtom) && managed?.isolated === true;
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
    appAtomRegistry.set(workspaceIsolatedAtom, false);
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
      <AppBar title={gt("Workspace")} hideBottomBorder onBack={() => navigation.goBack()} />
      <ScreenContent>
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
              title={gt("New workspace")}
              subtitle={gt("A separate copy for this task")}
              selected={isNew && !isolated}
              onPress={() => {
                appAtomRegistry.set(workspaceIsolatedAtom, false);
                flow.setWorkspaceMode("worktree");
                navigation.goBack();
              }}
            />
            {managed?.isolated ? (
              <SelectionRow
                title={gt("New isolated workspace")}
                subtitle={gt("A clean room that can't see your other projects")}
                selected={isNew && isolated}
                onPress={() => {
                  appAtomRegistry.set(workspaceIsolatedAtom, true);
                  flow.setWorkspaceMode("worktree");
                  navigation.goBack();
                }}
              />
            ) : null}
            <SelectionRow
              title={gt("Project checkout")}
              selected={!isNew && flow.selectedWorktreePath === null}
              onPress={() => {
                appAtomRegistry.set(workspaceIsolatedAtom, false);
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
            accessibilityLabel={gt("Find workspace")}
            placeholder={gt("Find workspace…")}
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
                subtitle={
                  workspace.runningCount > 0
                    ? gt(
                        "{threadCount, plural, one {{threadCount} thread} other {{threadCount} threads}} · {runningCount} running",
                        {
                          threadCount: workspace.threadCount,
                          runningCount: workspace.runningCount,
                        },
                      )
                    : workspace.settled
                      ? gt(
                          "{threadCount, plural, one {{threadCount} thread} other {{threadCount} threads}} · Settled",
                          { threadCount: workspace.threadCount },
                        )
                      : gt(
                          "{threadCount, plural, one {{threadCount} thread} other {{threadCount} threads}}",
                          { threadCount: workspace.threadCount },
                        )
                }
                selected={!isNew && flow.selectedWorktreePath === workspace.path}
                onPress={() => selectWorkspace(workspace.path, workspace.branch)}
                isLast={index === workspaces.length - 1}
              />
            ))}
            {workspaces.length === 0 ? (
              <Text className="p-4 text-sm text-foreground-muted">
                {archive.isLoading
                  ? gt("Loading settled workspaces…")
                  : (archive.error ?? gt("No matching workspaces."))}
              </Text>
            ) : null}
          </PickerSurface>
          <PickerSurface>
            <ToggleRow
              title={gt("Show settled")}
              value={showSettled}
              onValueChange={setShowSettled}
            />
          </PickerSurface>
          {isNew && isolated ? (
            <>
              <Pressable
                accessibilityRole="button"
                onPress={() => setAdvanced(!advanced)}
                className="px-4 py-2"
              >
                <Text className="text-sm text-foreground-muted">
                  {advanced ? gt("Hide clean room setup") : gt("Clean room setup")}
                </Text>
              </Pressable>
              {advanced ? (
                <PickerSurface>
                  {(["familiar", "minimal"] as const).map((value) => (
                    <SelectionRow
                      key={value}
                      title={
                        value === "familiar"
                          ? gt("Familiar", { $context: "clean room setup profile" })
                          : gt("Minimal", { $context: "clean room setup profile" })
                      }
                      subtitle={
                        value === "familiar"
                          ? gt("Keeps your global instructions and skills")
                          : gt("Starts with the project's own instructions and tools")
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
      </ScreenContent>
    </View>
  );
}
