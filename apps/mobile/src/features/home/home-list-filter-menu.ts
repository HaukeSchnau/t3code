import type { EnvironmentId } from "@t3tools/contracts";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import type { useEnvironmentModeMenu } from "../connection/environmentModes";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

export function buildHomeListFilterMenuItems(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly modeMenu?: ReturnType<typeof useEnvironmentModeMenu>;
}): AppBarMenuItem[] {
  const items: AppBarMenuItem[] = [];
  const modeMenu = props.modeMenu;
  if (modeMenu?.visible) {
    items.push({
      id: "mode",
      title: `Mode: ${modeMenu.label}`,
      items: modeMenu.actions.map((action) => ({
        id: `mode:${action.id}`,
        title: action.title,
        selected: action.state === "on",
        onPress: () => modeMenu.select(action.id),
      })),
    });
  }
  items.push({
    id: "environment",
    title: "Environment",
    items: [
      {
        id: "environment:all",
        title: "All environments",
        subtitle: "Show threads from every environment",
        selected: props.selectedEnvironmentId === null,
        onPress: () => props.onEnvironmentChange(null),
      },
      ...props.environments.map((environment) => ({
        id: `environment:${environment.environmentId}`,
        title: environment.label,
        selected: props.selectedEnvironmentId === environment.environmentId,
        onPress: () => props.onEnvironmentChange(environment.environmentId),
      })),
    ],
  });

  if (props.projects.length > 0) {
    items.push({
      id: "project",
      title: "Project",
      items: [
        {
          id: "project:all",
          title: "All projects",
          subtitle: "Show threads from every project",
          selected: props.selectedProjectKey === null,
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          id: `project:${project.key}`,
          title: project.label,
          selected: props.selectedProjectKey === project.key,
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  return items;
}
