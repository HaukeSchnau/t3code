import {
  declaredWorldsFromConfigs,
  fileProjectsIntoWorlds,
  type WorldFiling,
} from "@t3tools/client-runtime/state/worlds";

import type { ProjectIconColor } from "@t3tools/contracts";

import { projectAutoMonogram } from "../../lib/projectIcon";
import { useProjects, useServerConfigs } from "../../state/entities";

/** Every project filed into its world (patches/worlds.md), from the projects of all machines. */
export function useWorldFiling(): WorldFiling {
  const projects = useProjects();
  const worlds = declaredWorldsFromConfigs(useServerConfigs());
  return fileProjectsIntoWorlds({ projects, worlds });
}

/**
 * Changes only when a project moves to another world or a world is renamed. Lists put it in their
 * rows' extraData, so rows rendered before the filing settled get their stripe.
 */
export function worldFilingKey(filing: WorldFiling): string {
  return [
    ...filing.worlds.map((world) => `${world.id}\0${world.title}`),
    ...[...filing.worldByProjectKey].map(([projectKey, world]) => `${projectKey}\0${world}`).sort(),
  ].join("\n");
}

/** The color of the world a project is filed under: its world project's monogram color. */
export function worldColorFor(
  filing: WorldFiling,
  projectKey: string,
): ProjectIconColor | undefined {
  const world = filing.worldByProjectKey.get(projectKey);
  const title = filing.worlds.find((candidate) => candidate.id === world)?.title;
  const glyph = title === undefined ? null : projectAutoMonogram(title);
  return glyph?.kind === "monogram" ? glyph.color : undefined;
}
