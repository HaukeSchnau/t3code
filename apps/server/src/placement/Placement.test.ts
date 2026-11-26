import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, type PlacementReport, ProjectId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as LocalPlacement from "./LocalPlacement.ts";
import {
  type PeerMatch,
  type PlacementChoice,
  type PlacementRequest,
  PLACEMENT_REPORT_PATH,
  layer as placementLayer,
  Placement,
  recordMatch,
  retryRefusal,
  shareableRepositoryKey,
  withoutCredentials,
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
  mayClone: true,
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

it("sends peers a clone URL and a repository key without credentials", () => {
  assert.equal(
    withoutCredentials("https://user:token@git.example.com/acme/app.git?private_token=t#x"),
    "https://git.example.com/acme/app.git",
  );
  assert.equal(
    withoutCredentials("https://token@git.example.com/app"),
    "https://git.example.com/app",
  );
  assert.equal(
    withoutCredentials("ssh://git@git.example.com/acme/app.git"),
    "ssh://git@git.example.com/acme/app.git",
  );
  assert.equal(
    withoutCredentials("git@git.example.com:acme/app.git"),
    "git@git.example.com:acme/app.git",
  );
  assert.equal(shareableRepositoryKey("git.example.com/acme/app"), "git.example.com/acme/app");
  for (const leaky of [
    "https://token@git.example.com/app",
    "token@git.example.com/app",
    "git.example.com/app?t=1",
  ]) {
    assert.isNull(shareableRepositoryKey(leaky), leaky);
  }
});

const loadReport = (label: string, weight: number): PlacementReport => ({
  environmentId: EnvironmentId.make(label),
  label,
  platform: "linux",
  weight,
  agentLimit: null,
  resources: {
    sampledAt: 0,
    cpuUtilization: 0,
    cpuCount: 16,
    availableMemoryBytes: 64 * 1024 ** 3,
    totalMemoryBytes: 64 * 1024 ** 3,
  },
  runningAgents: 0,
  launchesInFlight: 0,
  waiting: 0,
  worlds: [],
  providers: [],
});

const withPeer = <A, E>(
  body: (
    placement: Placement["Service"],
    peerState: { readonly reportRequests: Ref.Ref<number>; readonly answers: Ref.Ref<boolean> },
  ) => Effect.Effect<A, E, Layer.Success<typeof placementLayer>>,
) =>
  Effect.gen(function* () {
    const reportRequests = yield* Ref.make(0);
    const answers = yield* Ref.make(true);
    const peer = {
      environmentId: EnvironmentId.make("peer"),
      label: "peer",
      urls: ["http://peer.test"],
      access: "full-access",
      linkedAt: DateTime.makeUnsafe(0),
      expiresAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
      lastReachedAt: null,
      lastError: null,
    } as const;
    const services = Layer.mergeAll(
      // This machine takes no placed work, so a preview lands on the peer while its report is fresh.
      Layer.mock(LocalPlacement.LocalPlacement)({
        report: () => Effect.succeed(loadReport("here", 0)),
      }),
      Layer.mock(PeerLinks.PeerLinks)({
        enabled: Effect.succeed(true),
        stored: Effect.succeed([peer]),
        resolve: () =>
          Effect.succeed({ link: peer, url: "http://peer.test", token: "token" } as never),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.gen(function* () {
            if (request.url.endsWith(PLACEMENT_REPORT_PATH))
              yield* Ref.update(reportRequests, (n) => n + 1);
            return HttpClientResponse.fromWeb(
              request,
              (yield* Ref.get(answers))
                ? new Response(JSON.stringify(loadReport("peer", 100)))
                : new Response(null, { status: 503 }),
            );
          }),
        ),
      ),
      Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
      Layer.mock(DocumentText.DocumentText)({}),
      ServerSettings.layerTest(),
      NodeCrypto.layer,
    );
    return yield* Effect.gen(function* () {
      return yield* body(yield* Placement, { reportRequests, answers });
    }).pipe(
      Effect.provide(
        placementLayer.pipe(
          Layer.provide(services),
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-placement-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  });

const scratchLaunch: PlacementRequest = {
  projectId: null,
  instanceId: undefined,
  workspaceStrategy: { type: "root" },
  hasAttachments: false,
  hasContext: false,
  mayClone: false,
};

it.effect("asks a peer for its load only when a decision needs a fresh report", () =>
  withPeer((placement, { reportRequests, answers }) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* placement.start();
        yield* TestClock.adjust("1 minute");
        assert.equal(yield* Ref.get(reportRequests), 0);

        assert.equal((yield* placement.preview(scratchLaunch))?.label, "peer");
        assert.equal(yield* Ref.get(reportRequests), 1);
        // A report younger than five seconds is reused.
        yield* TestClock.adjust("4 seconds");
        assert.equal((yield* placement.preview(scratchLaunch))?.label, "peer");
        assert.equal(yield* Ref.get(reportRequests), 1);
        yield* TestClock.adjust("2 seconds");
        assert.equal((yield* placement.preview(scratchLaunch))?.label, "peer");
        assert.equal(yield* Ref.get(reportRequests), 2);
        // A peer that stops answering is not placed on its last report, though that is recent.
        yield* Ref.set(answers, false);
        yield* TestClock.adjust("6 seconds");
        assert.isNull(yield* placement.preview(scratchLaunch));
        assert.equal(yield* Ref.get(reportRequests), 3);
      }),
    ),
  ),
);
