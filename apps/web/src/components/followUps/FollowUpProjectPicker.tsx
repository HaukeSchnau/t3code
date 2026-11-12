import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  pickableProjectGroups,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { MessageSquarePlusIcon } from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
} from "~/sidebarProjectGrouping";
import { useProjects, useVisibleThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { DraftProjectName } from "../chat/DraftProjectName";
import { ProjectFavicon } from "../ProjectFavicon";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";

interface PickerItem {
  readonly value: string;
  readonly label: string;
}

/** "Start a thread" for a follow-up whose origin project this client does not know. */
export function FollowUpProjectPicker(props: {
  readonly disabled: boolean;
  readonly onPick: (project: EnvironmentProject) => void;
}) {
  const projects = useProjects();
  const threads = useVisibleThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const filter = useComboboxFilter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const environmentLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const entries = buildSidebarProjectPickerEntries({
    groups: pickableProjectGroups(
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    ),
    preferredProjectRef: null,
  }).filter((entry) => !entry.group.isScratch);
  const entryByKey = new Map(entries.map((entry) => [entry.group.projectKey, entry] as const));
  const items: ReadonlyArray<PickerItem> = entries.map(({ group }) => ({
    value: group.projectKey,
    label: group.displayName,
  }));
  const search = query.trim();
  const filteredItems =
    search.length === 0
      ? items
      : items.filter((item) => filter.contains(item, search, (candidate) => candidate.label));
  return (
    <Combobox
      items={items}
      filteredItems={filteredItems}
      autoHighlight
      itemToStringLabel={(item: PickerItem) => item.label}
      isItemEqualToValue={(left: PickerItem, right: PickerItem) => left.value === right.value}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
      }}
      value={null}
      onValueChange={(item: PickerItem | null) => {
        if (!item) return;
        setOpen(false);
        const target = entryByKey.get(item.value)?.targetProject;
        const project = projects.find(
          (candidate) =>
            candidate.environmentId === target?.environmentId && candidate.id === target.id,
        );
        if (project) props.onPick(project);
      }}
    >
      <ComboboxTrigger
        render={<Button size="sm" disabled={props.disabled || entries.length === 0} />}
      >
        <MessageSquarePlusIcon />
        Start a thread
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="w-72 overflow-hidden">
        <ComboboxSearchInput
          aria-label="Search projects"
          placeholder="Start it in which project?"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No matching projects.</ComboboxEmpty>
        <ComboboxList>
          {(item: PickerItem) => {
            const entry = entryByKey.get(item.value);
            return (
              <ComboboxItem key={item.value} hideIndicator value={item}>
                {entry ? (
                  <ProjectFavicon project={entry.group} className="size-4 shrink-0" />
                ) : null}
                <span className="min-w-0 flex-1 text-sm">
                  <DraftProjectName value={item.label} />
                </span>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
