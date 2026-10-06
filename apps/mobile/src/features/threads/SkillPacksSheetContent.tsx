import type { EnvironmentId, ProjectId, SkillPackId, ThreadId } from "@t3tools/contracts";
import {
  resolveSkillPackProviderWarning,
  resolveSkillPackSelection,
} from "@t3tools/client-runtime/skillPacks";
import * as Haptics from "expo-haptics";
import { useMemo } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { skillPackEnvironment } from "../../state/skill-packs";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildSkillPacksSheetRows, type SkillPacksSheetSession } from "./skill-packs-session";
import { ChoiceRow } from "./ThreadSettingsRows";

/** Fork: skill packs (patches/skill-packs.md). */
function useSkillPackSession(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  /** Set for an existing thread; drafts pass their picks instead. */
  readonly threadId: ThreadId | null;
  readonly draftPackIds?: ReadonlyArray<SkillPackId> | undefined;
  readonly setDraftPackIds?: (packIds: ReadonlyArray<SkillPackId> | undefined) => void;
  readonly providerDriver: string | null;
}): SkillPacksSheetSession | null {
  const { environmentId, projectId, threadId, draftPackIds, setDraftPackIds } = input;
  const catalog = useEnvironmentServerConfig(environmentId)?.skillPackCatalog ?? null;
  const state = useEnvironmentQuery(
    catalog === null || environmentId === null || projectId === null
      ? null
      : skillPackEnvironment.state({
          environmentId,
          input: threadId === null ? { projectId } : { projectId, threadId },
        }),
  ).data;
  const setThreadPacks = useAtomCommand(skillPackEnvironment.setThreadPacks, "set skill packs");
  const setProjectDefault = useAtomCommand(
    skillPackEnvironment.setProjectDefault,
    "save the project's default skills",
  );

  return useMemo(() => {
    if (catalog === null || environmentId === null || projectId === null) return null;
    const projectDefaultPackIds = state?.projectDefaultPackIds ?? [];
    const selection = resolveSkillPackSelection({
      catalog,
      projectDefaultPackIds,
      ...(threadId === null ? { draftPackIds } : { threadScope: state?.thread }),
    });
    const applyPackIds = (packIds: ReadonlyArray<SkillPackId> | undefined) => {
      if (threadId === null) {
        setDraftPackIds?.(packIds);
        return;
      }
      void setThreadPacks({
        environmentId,
        input: { threadId, packIds: packIds ?? projectDefaultPackIds },
      });
    };
    return {
      catalog,
      selection,
      providerWarning: resolveSkillPackProviderWarning({
        driver: input.providerDriver,
        packIds: selection.packIds,
      }),
      onPackIdsChange: applyPackIds,
      onResetToProjectDefault: () => applyPackIds(undefined),
      onMakeProjectDefault: () => {
        void setProjectDefault({
          environmentId,
          input: { projectId, packIds: selection.packIds },
        }).then((result) => {
          if (result._tag === "Success" && threadId === null) setDraftPackIds?.(undefined);
        });
      },
    };
  }, [
    catalog,
    draftPackIds,
    environmentId,
    input.providerDriver,
    projectId,
    setDraftPackIds,
    setProjectDefault,
    setThreadPacks,
    state,
    threadId,
  ]);
}

export function useThreadSkillPacksSession(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly providerDriver: string | null;
}): SkillPacksSheetSession | null {
  return useSkillPackSession(input);
}

/** A new task keeps its picks in the draft until the task starts. */
export function useNewTaskSkillPacksSession(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly draftPackIds: ReadonlyArray<SkillPackId> | undefined;
  readonly setDraftPackIds: (packIds: ReadonlyArray<SkillPackId> | undefined) => void;
  readonly providerDriver: string | null;
}): SkillPacksSheetSession | null {
  return useSkillPackSession({ ...input, threadId: null });
}

/**
 * The skills page: profiles first, then the pack checklist, then what the
 * selection resolves to. Picking keeps the page open so several packs can be
 * toggled in one visit.
 */
export function SkillPacksChoiceContent(props: {
  readonly session: SkillPacksSheetSession;
  readonly onSelected: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { session } = props;
  const rows = buildSkillPacksSheetRows(session);
  const isDefault = session.selection.isProjectDefault;
  const select = (packIds: ReadonlyArray<SkillPackId>) => {
    void Haptics.selectionAsync();
    session.onPackIdsChange(packIds);
  };

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentContainerStyle={{ paddingBottom: insets.bottom + 12, paddingTop: 16 }}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <Text className="px-5 pb-2 text-sm text-foreground-muted">Core skills are always on.</Text>
      {rows.profiles.length > 0 ? (
        <>
          <Text className="px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted">
            Profiles
          </Text>
          <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
            {rows.profiles.map((row, index) => (
              <ChoiceRow
                key={row.id}
                {...(row.description ? { description: row.description } : {})}
                isLast={index === rows.profiles.length - 1}
                label={row.label}
                selected={row.selected}
                onPress={() => select(row.packIds)}
              />
            ))}
          </View>
        </>
      ) : null}
      <Text className="px-5 pb-2 pt-6 text-sm font-t3-medium text-foreground-muted">Packs</Text>
      <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
        {rows.packs.map((row, index) => (
          <ChoiceRow
            key={row.id}
            {...(row.description ? { description: row.description } : {})}
            isLast={index === rows.packs.length - 1}
            label={row.label}
            selected={row.selected}
            onPress={() =>
              select(
                row.selected
                  ? session.selection.packIds.filter((id) => !row.packIds.includes(id))
                  : [...session.selection.packIds, ...row.packIds],
              )
            }
          />
        ))}
      </View>
      <Text className="px-5 pb-2 pt-6 text-sm font-t3-medium text-foreground-muted">Details</Text>
      <View className="mx-4 gap-1.5 overflow-hidden rounded-2xl bg-grouped-card px-4 py-3">
        {rows.notices.map((notice) => (
          <Text key={notice} className="text-sm leading-5 text-warning-foreground">
            {notice}
          </Text>
        ))}
        {rows.details.map((line) => (
          <Text key={line} className="text-sm leading-5 text-foreground-muted">
            {line}
          </Text>
        ))}
      </View>
      <View className="mx-4 mt-6 overflow-hidden rounded-2xl bg-grouped-card">
        <ChoiceRow
          label="Reset to project default"
          {...(isDefault ? { description: "Already the project default" } : {})}
          selected={false}
          isLast={false}
          onPress={() => {
            if (isDefault) return;
            void Haptics.selectionAsync();
            session.onResetToProjectDefault();
            props.onSelected();
          }}
        />
        <ChoiceRow
          label="Make project default"
          {...(isDefault ? { description: "Already the project default" } : {})}
          selected={false}
          isLast
          onPress={() => {
            if (isDefault) return;
            void Haptics.selectionAsync();
            session.onMakeProjectDefault();
            props.onSelected();
          }}
        />
      </View>
    </ScrollView>
  );
}
