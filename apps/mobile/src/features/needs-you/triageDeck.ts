import { needsYouDeckThreads } from "@t3tools/client-runtime/state/needs-you-triage";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

import type { ResolvedHomeListOptions } from "../home/home-list-options";
import { buildHomeProjectScopes, resolveHomeProjectScope } from "../home/homeThreadList";
import { buildThreadListV2Items } from "../threads/threadListV2";

/**
 * The thread list's Needs you section under the list's environment and project filters, taken
 * from the list's own layout. The list hides the section while it searches, so no search applies.
 */
export function triageDeckThreads(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly options: Pick<
    ResolvedHomeListOptions,
    "selectedEnvironmentId" | "selectedProjectKey" | "projectGroupingMode"
  >;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly now: string;
}) {
  const { threads, projects, options, snoozeEnvironmentIds, now } = input;
  const projectScope = resolveHomeProjectScope({
    scopes: buildHomeProjectScopes({
      projects,
      environmentId: options.selectedEnvironmentId,
      projectGroupingMode: options.projectGroupingMode,
    }),
    projects,
    projectKey: options.selectedProjectKey,
    projectGroupingMode: options.projectGroupingMode,
  });
  const layout = buildThreadListV2Items({
    threads,
    environmentId: options.selectedEnvironmentId,
    projectRefs: projectScope?.projectRefs ?? null,
    searchQuery: "",
    settlementEnvironmentIds: input.settlementEnvironmentIds,
    snoozeEnvironmentIds,
    now,
  });
  const listed = new Set(layout.items.slice(0, layout.needsYouCount).map((item) => item.thread));
  return needsYouDeckThreads(threads, {
    now,
    isListed: (thread) => listed.has(thread),
    honorsSnooze: (thread) => snoozeEnvironmentIds.has(thread.environmentId),
  });
}

/** A card's page: the version picked (undefined follows the newest) and each version's height. */
export interface TriagePageView {
  readonly renderId: string | null;
  readonly selected: number | undefined;
  readonly heights: ReadonlyMap<string, number>;
}

/** The view for the card's page now. Another page starts at its newest version, unmeasured. */
export function triagePageView(view: TriagePageView, renderId: string | null): TriagePageView {
  return view.renderId === renderId ? view : { renderId, selected: undefined, heights: new Map() };
}
