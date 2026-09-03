import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { withFixtureCatalog } from "../components/orchestration-fixture/fixtureEnvironment";
import { environmentSnapshotAtom } from "./shell";

export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime);
/**
 * Web-only: project content search backs the ⇧⌘F dialog, which has no mobile
 * surface, so the atom family lives here instead of the shared client-runtime
 * project atoms consumed by the mobile app.
 */
export const projectContentSearch = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:search-contents",
  tag: WS_METHODS.projectsSearchContents,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
const projectCatalogValueAtom = import.meta.env.DEV
  ? withFixtureCatalog(environmentCatalog.catalogValueAtom)
  : environmentCatalog.catalogValueAtom;
export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: projectCatalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
