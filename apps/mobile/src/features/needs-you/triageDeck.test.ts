import { derivePhysicalProjectKey } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, RunId, ThreadAskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import { triageDeckThreads } from "./triageDeck";

const NOW = "2026-06-01T12:00:00.000Z";

function project(environment: string, id: string, isScratch: boolean): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environment),
    id: ProjectId.make(id),
    title: isScratch ? "No project" : id,
    workspaceRoot: `/${environment}/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...(isScratch ? { isScratch: true } : {}),
  };
}

describe("triageDeckThreads", () => {
  it("deals the Needs you rows under the list's project filter, a legacy scratch key included", () => {
    const projects = [
      project("local", "scratch-local", true),
      project("remote", "scratch-remote", true),
      project("remote", "ordinary", false),
    ];
    const threads = projects.map((owner) =>
      makeThreadShellFixture({
        environmentId: owner.environmentId,
        projectId: owner.id,
        id: ThreadId.make(`thread-${owner.id}`),
        title: owner.id,
        openAsks: [
          {
            id: ThreadAskId.make(`turn_end:${owner.id}`),
            source: { type: "turn_end", runId: RunId.make(`run-${owner.id}`) },
            text: "Which one?",
            raisedAt: "2026-06-01T10:00:00.000Z",
          },
        ],
      }),
    );
    const deck = (selectedProjectKey: string | null) =>
      triageDeckThreads({
        threads,
        projects,
        options: {
          selectedEnvironmentId: null,
          selectedProjectKey,
          projectGroupingMode: "separate",
        },
        settlementEnvironmentIds: new Set(),
        snoozeEnvironmentIds: new Set(),
        now: NOW,
      })
        .map((thread) => thread.id)
        .sort();

    expect(deck(null)).toHaveLength(3);
    // A "No project" filter saved before scratch homes were shared names one host's scratch
    // project; Home reads it as every scratch thread, and so does triage.
    expect(deck(derivePhysicalProjectKey(projects[0]!))).toEqual([
      "thread-scratch-local",
      "thread-scratch-remote",
    ]);
  });
});
