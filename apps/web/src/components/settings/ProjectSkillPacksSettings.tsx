import type { EnvironmentId, ProjectId, SkillPackId } from "@t3tools/contracts";
import {
  formatSkillPackSelectionLabel,
  resolveSkillPackSelection,
} from "@t3tools/client-runtime/skillPacks";
import { ChevronDownIcon } from "lucide-react";

import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { skillPackEnvironment } from "../../state/skillPacks";
import { useAtomCommand } from "../../state/use-atom-command";
import { SkillPacksPanel } from "../chat/SkillPacksControl";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

interface ProjectMember {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

/**
 * Fork: the project's default skill packs (patches/skill-packs.md). A project
 * group shares one default, so an edit fans out to every member.
 */
export function ProjectSkillPacksSettings(props: {
  readonly representative: ProjectMember;
  readonly members: ReadonlyArray<ProjectMember>;
}) {
  const { representative } = props;
  const catalog =
    useEnvironment(representative.environmentId)?.serverConfig?.skillPackCatalog ?? null;
  const state = useEnvironmentQuery(
    catalog === null
      ? null
      : skillPackEnvironment.state({
          environmentId: representative.environmentId,
          input: { projectId: representative.id },
        }),
  ).data;
  const setProjectDefault = useAtomCommand(
    skillPackEnvironment.setProjectDefault,
    "save the project's default skills",
  );

  if (catalog === null) return null;
  const selection = resolveSkillPackSelection({
    catalog,
    projectDefaultPackIds: state?.projectDefaultPackIds,
  });
  const setDefault = async (packIds: ReadonlyArray<SkillPackId>) => {
    for (const member of props.members) {
      const result = await setProjectDefault({
        environmentId: member.environmentId,
        input: { projectId: member.id, packIds },
      });
      if (result._tag === "Failure") return;
    }
  };

  return (
    <SettingsRow
      title="Skills"
      description="Skill packs new threads in this project start with. Core skills are always on, and a thread can still pick its own packs."
      resetAction={
        selection.packIds.length > 0 ? (
          <SettingResetButton label="project default skills" onClick={() => void setDefault([])} />
        ) : null
      }
      control={
        <Popover>
          <PopoverTrigger
            render={<Button variant="outline" size="sm" aria-label="Default skills" />}
          >
            {formatSkillPackSelectionLabel(catalog, selection)}
            <ChevronDownIcon className="size-3.5 text-icon-muted" />
          </PopoverTrigger>
          <PopoverPopup align="end" width="md" padding="compact">
            <SkillPacksPanel
              catalog={catalog}
              selection={selection}
              providerWarning={null}
              onPackIdsChange={(packIds) => void setDefault(packIds)}
            />
          </PopoverPopup>
        </Popover>
      }
    />
  );
}
