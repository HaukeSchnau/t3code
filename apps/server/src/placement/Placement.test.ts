import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  type PeerMatch,
  type PlacementChoice,
  type PlacementRequest,
  recordMatch,
  retryRefusal,
} from "./Placement.ts";

const peerChoice: PlacementChoice = {
  _tag: "Peer",
  environmentId: EnvironmentId.make("dev-hauke"),
  target: { projectId: ProjectId.make("project-there") },
  placement: {
    decidedBy: { environmentId: EnvironmentId.make("tower"), label: "tower" },
    environmentId: EnvironmentId.make("dev-hauke"),
    label: "dev-hauke",
    reason: "3 free agent slots",
    candidates: [],
    decidedAt: "2026-11-24T12:00:00.000Z",
    waitingSince: null,
  },
};

const request = (hasAttachments: boolean): PlacementRequest => ({
  projectId: ProjectId.make("project-here"),
  instanceId: undefined,
  workspaceStrategy: { type: "root" },
  hasAttachments,
  hasContext: false,
});

it("refuses a retry that must stay here once its first attempt went to a peer", () => {
  assert.include(retryRefusal(peerChoice, request(true)), "dev-hauke");
  assert.isNull(retryRefusal(peerChoice, request(false)));
  assert.isNull(retryRefusal({ _tag: "Here", placement: undefined }, request(true)));
  // A workspace without a base starts from the local branch, so it stays here too.
  assert.isNotNull(
    retryRefusal(peerChoice, { ...request(false), workspaceStrategy: { type: "workspace" } }),
  );
  assert.isNull(
    retryRefusal(peerChoice, {
      ...request(false),
      workspaceStrategy: { type: "workspace", startFromOrigin: true },
    }),
  );
});

it("keeps the answer of the probe that asked last when probes answer out of order", () => {
  const matches = new Map<string, PeerMatch>();
  // Probes are numbered as they ask, so two in the same millisecond are still ordered.
  const a = { projectId: ProjectId.make("project-a"), at: 30, askedAt: 1 };
  const b = { projectId: ProjectId.make("project-b"), at: 30, askedAt: 2 };
  // A asks, B asks, A answers, B answers.
  recordMatch(matches, "peer repo", a);
  recordMatch(matches, "peer repo", b);
  assert.equal(matches.get("peer repo")?.projectId, "project-b");
  // Answering in the other order, B still stands.
  const other = new Map<string, PeerMatch>();
  recordMatch(other, "peer repo", b);
  recordMatch(other, "peer repo", a);
  assert.equal(other.get("peer repo")?.projectId, "project-b");
});
