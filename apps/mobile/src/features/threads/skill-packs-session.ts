import type { SkillPackCatalog, SkillPackId } from "@t3tools/contracts";
import {
  describeSkillPackSkills,
  formatSkillPackSelectionLabel,
  resolveEffectiveSkills,
  type SkillPackSelection,
} from "@t3tools/client-runtime/skillPacks";

/**
 * What the thread settings sheet needs to show and edit skill packs. Built by
 * the thread composer state for existing threads and by the new-task flow for
 * drafts; the sheet itself stays presentational.
 */
export interface SkillPacksSheetSession {
  readonly catalog: SkillPackCatalog;
  readonly selection: SkillPackSelection;
  readonly providerWarning: string | null;
  readonly onPackIdsChange: (packIds: ReadonlyArray<SkillPackId>) => void;
  readonly onResetToProjectDefault: () => void;
  readonly onMakeProjectDefault: () => void;
}

/** Value text for the "Skills" disclosure row, with the scope state appended. */
export function skillPacksRowValue(
  session: Pick<SkillPacksSheetSession, "catalog" | "selection">,
): string {
  const label = formatSkillPackSelectionLabel(session.catalog, session.selection);
  switch (session.selection.state) {
    case "pending":
      return `${label} · pending`;
    case "degraded":
      return `${label} · issue`;
    case "ready":
      return label;
  }
}

export interface SkillPacksSheetRow {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly selected: boolean;
  readonly packIds: ReadonlyArray<SkillPackId>;
}

/**
 * Rows for the skills page. Profile rows apply their pack set; pack rows
 * toggle one pack. Detail lines describe what the selection resolves to,
 * naming skills a pack repeats from core or an earlier pack.
 */
export function buildSkillPacksSheetRows(
  session: Pick<SkillPacksSheetSession, "catalog" | "selection" | "providerWarning">,
): {
  readonly profiles: ReadonlyArray<SkillPacksSheetRow>;
  readonly packs: ReadonlyArray<SkillPacksSheetRow>;
  readonly details: ReadonlyArray<string>;
  readonly notices: ReadonlyArray<string>;
} {
  const { catalog, selection } = session;
  const selected = new Set(selection.packIds);
  const skillName = (skillId: string) =>
    catalog.skills.find((skill) => skill.id === skillId)?.displayName ?? skillId;
  const packName = (packId: string) =>
    catalog.packs.find((pack) => pack.id === packId)?.displayName ?? packId;
  const details = [
    `Core: ${catalog.coreSkillIds.map(skillName).join(", ")}`,
    ...catalog.packs
      .filter((pack) => selected.has(pack.id))
      .map(
        (pack) =>
          `${pack.displayName}: ${describeSkillPackSkills(catalog, pack, selection.packIds)
            .map((row) =>
              row.providedBy
                ? `${row.skill.displayName} (already in ${
                    row.providedBy === "core" ? "core" : packName(row.providedBy)
                  })`
                : row.skill.displayName,
            )
            .join(", ")}`,
      ),
    `${resolveEffectiveSkills(catalog, selection.packIds).length} skills in total`,
  ];
  const notices = [
    ...(selection.state === "degraded"
      ? [selection.issue ?? "Some skills could not be injected for this thread."]
      : selection.state === "pending"
        ? ["Applies on the next turn."]
        : []),
    ...(session.providerWarning ? [session.providerWarning] : []),
  ];
  return {
    profiles: catalog.profiles.map((profile) => ({
      id: profile.id,
      label: profile.displayName,
      description: profile.description,
      selected: selection.profile?.id === profile.id,
      packIds: profile.packIds,
    })),
    packs: catalog.packs.map((pack) => ({
      id: pack.id,
      label: pack.displayName,
      description: pack.description,
      selected: selected.has(pack.id),
      packIds: [pack.id],
    })),
    details,
    notices,
  };
}
