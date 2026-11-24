/**
 * Placement of new threads across this environment and its linked peers
 * (patches/fleet-placement.md). Peers' load arrives every few seconds over their links; a launch
 * picks its machine at once and, when none has room, waits on the best one.
 */
import {
  CommandId,
  type EnvironmentId,
  type PlacementCandidate,
  type PlacementMatch,
  PlacementError,
  type PlacementPreview,
  PlacementReport,
  type ProjectId,
  type ProviderInstanceId,
  type RuntimeMode,
  type ProviderInteractionMode,
  repositoryGroupingKeyOf,
  RunId,
  ThreadId,
  ThreadPlacement,
} from "@t3tools/contracts";
import { decidePlacement, type PlacementOption } from "@t3tools/shared/placement";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerConfig from "../config.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LocalPlacement from "./LocalPlacement.ts";

export const PLACEMENT_REPORT_PATH = "/mcp/placement/report";
export const PLACEMENT_LAUNCH_PATH = "/mcp/placement/launch";

const POLL_INTERVAL = "5 seconds";
const REPORT_TIMEOUT = Duration.seconds(3);
// Finding the project there may resolve every project's repository for the first time.
const MATCH_TIMEOUT = Duration.seconds(10);
// A launch there checks its base and records the thread before it answers.
const LAUNCH_TIMEOUT = Duration.seconds(60);
// How long a peer's project for a repository or world is trusted before asking again.
const MATCH_TTL_MS = 60_000;
// A launch sent to a peer counts against it until its reports have had time to show it.
const SENT_LAUNCH_TTL_MS = 20_000;
const RESUME_RETRY_INTERVAL = "10 seconds";
const DECISION_TTL_MS = 10 * 60_000;

/** What a launch needs, so placement knows which machines can take it. */
export interface PlacementRequest {
  /** The project here, or null for a new Scratch folder. */
  readonly projectId: ProjectId | null;
  /** Machines without this provider instance are left out; any machine when absent. */
  readonly instanceId: ProviderInstanceId | undefined;
  readonly workspaceStrategy: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
  readonly hasAttachments: boolean;
  readonly hasContext: boolean;
}

export type PlacementChoice =
  | { readonly _tag: "Here"; readonly placement: ThreadPlacement | undefined }
  | {
      readonly _tag: "Peer";
      readonly environmentId: EnvironmentId;
      /** Where the thread goes there: a project, or a new Scratch folder. */
      readonly target: { readonly projectId: ProjectId } | { readonly scratch: true };
      readonly placement: ThreadPlacement;
    };

const PeerLaunchResult = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
const decodeLaunched = Schema.decodeUnknownEffect(Schema.Struct({ threadId: ThreadId }));
const decodeLaunchedPlacement = Schema.decodeUnknownOption(
  Schema.Struct({
    placement: Schema.optional(
      Schema.Struct({ reason: Schema.String, waitingForRoom: Schema.Boolean }),
    ),
  }),
);
// A refusal there arrives as the tool's JSON failure; the message is what the caller needs.
const decodeRefusal = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
);

export class Placement extends Context.Service<
  Placement,
  {
    /** Where an auto launch of this request would go now, without launching. */
    readonly preview: (
      request: PlacementRequest,
    ) => Effect.Effect<PlacementPreview | null, PlacementError>;
    /** Picks the machine for an auto launch, and counts the launch against it. */
    /** `key` names a launch, so its retries reuse its first decision. */
    readonly decide: (
      request: PlacementRequest,
      key?: string,
    ) => Effect.Effect<PlacementChoice, PlacementError>;
    /** Runs `t3_thread_launch` on the chosen peer with the placement stamped on the thread. */
    /** Stops counting a peer choice whose launch was refused before it was sent. */
    readonly abandon: (choice: Extract<PlacementChoice, { _tag: "Peer" }>) => Effect.Effect<void>;
    readonly launchOnPeer: (
      choice: Extract<PlacementChoice, { _tag: "Peer" }>,
      args: Record<string, unknown>,
      limits: {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      },
      origin?: LocalPlacement.PlacementOrigin,
    ) => Effect.Effect<{ readonly threadId: ThreadId; readonly result: unknown }, PlacementError>;
    /** An auto launch from a client or a scheduled task: here, or on the peer placement picks. */
    readonly launch: (input: ThreadLaunch.ThreadLaunchInput) => Effect.Effect<
      {
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
        readonly placement: ThreadPlacement | undefined;
      },
      PlacementError | Effect.Error<ReturnType<typeof ThreadMessageIntake.launchThread>>
    >;
    /** Reads every linked peer's load every few seconds while this service lives. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/placement/Placement") {}

interface PeerState {
  readonly label: string;
  readonly report: PlacementReport | null;
  readonly receivedAt: number;
  /** The number of the probe behind `report`; an older probe that answers later never replaces it. */
  readonly askedAt: number;
}

const encodeReportRequest = Schema.encodeUnknownSync(
  Schema.Struct({ match: Schema.optional(Schema.Unknown) }),
);
const decodeReport = Schema.decodeUnknownEffect(PlacementReport);
const encodePlacement = Schema.encodeEffect(ThreadPlacement);
const decodeLaunchResult = Schema.decodeUnknownEffect(PeerLaunchResult);

const matchKey = (match: PlacementMatch) =>
  match.kind === "world"
    ? `world:${match.world}`
    : match.kind === "repo"
      ? `repo:${match.repository}:${match.path ?? ""}`
      : "scratch";

/** A launch sent to a peer, counted against it until its report includes it or it expires. */
interface SentLaunch {
  readonly at: number;
  /** When the peer created the thread; a report asked for after that counts it. */
  acceptedAt: number | undefined;
}

/** Why a launch must stay on this machine, if it must. */
function staysHere(request: PlacementRequest): string | null {
  if (request.hasAttachments) return "its attachments are on this machine";
  if (request.hasContext) return "its message refers to this machine";
  const strategy = request.workspaceStrategy;
  if (strategy.type === "existing_worktree") return "it continues an existing worktree";
  // A workspace without a base starts from the local branch, which may hold unpushed commits.
  if (
    (strategy.type === "worktree" || strategy.type === "workspace") &&
    strategy.startFromOrigin !== true
  ) {
    return "it branches from a local commit";
  }
  return null;
}

/** A peer's project for a repository folder, as of the probe numbered `askedAt`. */
export interface PeerMatch {
  readonly projectId: ProjectId | null;
  /** When the answer arrived; the cache entry is fresh for a minute after. */
  readonly at: number;
  readonly askedAt: number;
}

/** Records a probe's answer, unless the entry holds the answer to a probe that asked later. */
export function recordMatch(matches: Map<string, PeerMatch>, key: string, match: PeerMatch): void {
  const known = matches.get(key);
  if (known === undefined || known.askedAt < match.askedAt) matches.set(key, match);
}

/**
 * Why a retry may not reuse its first attempt's choice: one that must stay here (it now carries
 * attachments, say) cannot follow that attempt to a peer, and starting it here as well would
 * start it twice.
 */
export function retryRefusal(reused: PlacementChoice, request: PlacementRequest): string | null {
  const stays = staysHere(request);
  return reused._tag === "Peer" && stays !== null
    ? `Its first attempt went to ${reused.placement.label}, but ${stays}; start it again as a new launch.`
    : null;
}

const make = Effect.gen(function* () {
  const local = yield* LocalPlacement.LocalPlacement;
  const sql = yield* SqlClient.SqlClient;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const links = yield* PeerLinks.PeerLinks;
  const httpClient = yield* HttpClient.HttpClient;
  const projects = yield* ProjectService.ProjectService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const path = yield* Path.Path;
  const intakeContext = yield* Effect.context<
    | ThreadManagement.ThreadManagementService
    | ThreadLaunch.ThreadLaunchService
    | FileSystem.FileSystem
    | ServerConfig.ServerConfig
    | ServerSettings.ServerSettingsService
    | DocumentText.DocumentText
  >();
  const peers = yield* Ref.make<ReadonlyMap<EnvironmentId, PeerState>>(new Map());
  const matches = new Map<string, PeerMatch>();
  // Each probe's number, in the order the probes asked.
  let probes = 0;
  const sent = new Map<EnvironmentId, ReadonlyArray<SentLaunch>>();
  // The launch each peer choice counts, so the peer's next report can take it over.
  const sentByChoice = new WeakMap<object, SentLaunch>();

  const failure = (message: string) => new PlacementError({ message });

  // Resolved before every request: the link sends its token only to an address that still
  // answers as that peer.
  const resolve = (environmentId: EnvironmentId) =>
    links.resolve(environmentId).pipe(Effect.mapError((error) => failure(error.message)));

  const post = Effect.fn("Placement.post")(function* (
    environmentId: EnvironmentId,
    path: string,
    body: unknown,
    timeout: Duration.Input,
    limits?: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
  ) {
    const link = yield* resolve(environmentId);
    const request = yield* HttpClientRequest.post(`${link.url}${path}`).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${link.token}`,
        ...(limits === undefined
          ? {}
          : {
              [McpInvocationContext.MODE_LIMIT_HEADER]: `${limits.runtimeMode}/${limits.interactionMode}`,
            }),
      }),
      HttpClientRequest.bodyJson(body),
      Effect.mapError(() => failure("Could not encode the request.")),
    );
    const response = yield* httpClient.execute(request).pipe(
      Effect.timeout(timeout),
      Effect.mapError(() => failure(`${link.link.label} did not answer.`)),
    );
    if (response.status !== 200) {
      return yield* failure(`${link.link.label} answered HTTP ${response.status}.`);
    }
    // A peer that sends headers and then stalls the body must not hold a decision either.
    return yield* response.json.pipe(
      Effect.timeout(timeout),
      Effect.mapError(() => failure(`${link.link.label} answered in an unexpected shape.`)),
    );
  });

  /** Asks one peer for its load, and for its project for `match` when given. */
  const probe = Effect.fn("Placement.probe")(function* (
    environmentId: EnvironmentId,
    label: string,
    match?: PlacementMatch,
  ) {
    const startedAt = yield* Clock.currentTimeMillis;
    // Orders probes that start in the same millisecond too.
    const askedAt = ++probes;
    const body = yield* post(
      environmentId,
      PLACEMENT_REPORT_PATH,
      encodeReportRequest(match === undefined ? {} : { match }),
      match === undefined ? REPORT_TIMEOUT : MATCH_TIMEOUT,
    );
    const report = yield* decodeReport(body).pipe(
      Effect.mapError(() => failure(`${label} sent a load report this version cannot read.`)),
    );
    const receivedAt = yield* Clock.currentTimeMillis;
    // A launch the peer accepted before this report was asked for is in the report's counts.
    sent.set(
      environmentId,
      (sent.get(environmentId) ?? []).filter(
        (launch) => launch.acceptedAt === undefined || launch.acceptedAt > startedAt,
      ),
    );
    yield* Ref.update(peers, (current) =>
      (current.get(environmentId)?.askedAt ?? 0) > askedAt
        ? current
        : new Map(current).set(environmentId, {
            label: report.label,
            report,
            receivedAt,
            askedAt,
          }),
    );
    const key = match === undefined ? undefined : `${environmentId} ${matchKey(match)}`;
    if (key !== undefined && report.projectId !== undefined) {
      recordMatch(matches, key, {
        projectId: report.projectId,
        at: receivedAt,
        askedAt,
      });
    }
    return report;
  });

  const poll = Effect.gen(function* () {
    if (!(yield* links.enabled)) return;
    const now = yield* DateTime.now;
    const read = yield* links.stored.pipe(Effect.option);
    // An unreadable roster keeps the peers and reports already known until the next poll.
    if (Option.isNone(read)) return yield* Effect.logWarning("Placement could not read its links");
    const stored = read.value.filter((link) => DateTime.isGreaterThan(link.expiresAt, now));
    yield* Ref.update(peers, (current) => {
      const next = new Map<EnvironmentId, PeerState>();
      for (const link of stored) {
        next.set(
          link.environmentId,
          current.get(link.environmentId) ?? {
            label: link.label,
            report: null,
            receivedAt: 0,
            askedAt: 0,
          },
        );
      }
      return next;
    });
    yield* Effect.forEach(
      stored,
      (link) => probe(link.environmentId, link.label).pipe(Effect.ignore),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(Effect.withSpan("Placement.poll"));

  /** Threads that waited for room when the server stopped wait again. */
  const resumeWaiting = Effect.gen(function* () {
    const waiting = yield* sql<{ readonly thread_id: string; readonly run_id: string }>`
      SELECT runs.thread_id, runs.run_id
      FROM orchestration_v2_projection_runs runs
      JOIN orchestration_v2_projection_threads threads ON threads.thread_id = runs.thread_id
      WHERE runs.status = 'preparing'
        AND json_extract(threads.payload_json, '$.placement.waitingSince') IS NOT NULL
    `;
    yield* Effect.forEach(
      waiting,
      (row) =>
        threadLaunch.prepareRun({
          commandId: CommandId.make(`placement:resume:${row.run_id}`),
          threadId: ThreadId.make(row.thread_id),
          runId: RunId.make(row.run_id),
        }),
      { discard: true },
    );
  }).pipe(
    Effect.withSpan("Placement.resumeWaiting"),
    // Until it reads once, a thread that waited before the restart would never start.
    Effect.tapCause((cause) => Effect.logWarning("Placement could not resume waits", cause)),
    Effect.retry(Schedule.spaced(RESUME_RETRY_INTERVAL)),
  );

  const start: Placement["Service"]["start"] = () =>
    forkParked(
      Effect.all(
        [
          resumeWaiting,
          poll.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Placement could not read peer load", cause),
            ),
            Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
          ),
        ],
        { concurrency: 2, discard: true },
      ),
    );

  const sentLaunches = (environmentId: EnvironmentId, now: number) => {
    const recent = (sent.get(environmentId) ?? []).filter(
      (launch) => now - launch.at < SENT_LAUNCH_TTL_MS,
    );
    sent.set(environmentId, recent);
    return recent.length;
  };

  /** What the thread needs from a machine; null when it can only run here. */
  const matchFor = Effect.fn("Placement.matchFor")(function* (projectId: ProjectId | null) {
    if (projectId === null) return { kind: "scratch" } as const;
    const project = Option.getOrUndefined(
      yield* projects.getById(projectId).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    if (project === undefined) return yield* failure("The project was not found.");
    if (project.world != null) return { kind: "world", world: project.world } as const;
    if (yield* folders.isScratchProject(projectId)) return { kind: "scratch" } as const;
    const identity = yield* identities.resolve(project.workspaceRoot);
    return identity === null
      ? null
      : ({
          kind: "repo",
          // The key the sidebar groups copies by: a fork's own remote, not its upstream.
          repository: repositoryGroupingKeyOf(identity),
          path: LocalPlacement.repositoryFolder(
            path.relative(identity.rootPath ?? project.workspaceRoot, project.workspaceRoot),
          ),
        } as const);
  });

  const peerOption = Effect.fn("Placement.peerOption")(function* (
    environmentId: EnvironmentId,
    state: PeerState,
    match: PlacementMatch,
    instanceId: ProviderInstanceId | undefined,
    now: number,
  ) {
    let report = state.report;
    let receivedAt = state.receivedAt;
    let projectId: ProjectId | null = null;
    let answered = true;
    if (match.kind !== "scratch") {
      const key = `${environmentId} ${matchKey(match)}`;
      const known = matches.get(key);
      if (known !== undefined && now - known.at < MATCH_TTL_MS) {
        projectId = known.projectId;
      } else {
        const fresh = yield* probe(environmentId, state.label, match).pipe(Effect.option);
        answered = Option.isSome(fresh);
        if (Option.isSome(fresh)) {
          // Load from the newest report, which an older probe that answered late never replaced;
          // the match from the newest answer about it.
          const latest = (yield* Ref.get(peers)).get(environmentId);
          report = latest?.report ?? fresh.value;
          receivedAt = latest?.receivedAt ?? (yield* Clock.currentTimeMillis);
          // The newest answer about it, which the probe just recorded unless a newer one won.
          const cached = matches.get(key);
          projectId = cached === undefined ? (fresh.value.projectId ?? null) : cached.projectId;
        }
      }
    }
    const unavailable = (reason: string) => ({ unavailable: reason });
    const warmth =
      report === null
        ? 1
        : !answered
          ? unavailable("did not say whether it has the project")
          : instanceId !== undefined && !report.providers.includes(instanceId)
            ? unavailable(`does not run ${instanceId}`)
            : match.kind === "world" && !report.worlds.includes(match.world)
              ? unavailable(`does not serve the ${match.world} world`)
              : match.kind !== "scratch" && projectId === null
                ? unavailable(
                    match.kind === "world"
                      ? `has no project for the ${match.world} world`
                      : "has no clone of the repository",
                  )
                : 1;
    const option: PlacementOption = {
      environmentId,
      label: report?.label ?? state.label,
      report,
      receivedAt,
      sentLaunches: sentLaunches(environmentId, now),
      warmth,
    };
    return {
      option,
      target:
        match.kind === "scratch"
          ? ({ scratch: true } as const)
          : projectId === null
            ? null
            : { projectId },
    };
  });

  const decideFor = Effect.fn("Placement.decideFor")(function* (request: PlacementRequest) {
    const self = yield* local.report();
    const decidedAt = yield* DateTime.now;
    const now = DateTime.toEpochMillis(decidedAt);
    const decidedBy = { environmentId: self.environmentId, label: self.label };
    const stays = staysHere(request);
    const match = stays === null ? yield* matchFor(request.projectId) : null;
    if (match === null) {
      return {
        decision: null,
        self,
        decidedAt,
        decidedBy,
        stays: stays ?? "its project has no remote repository",
        targets: new Map(),
      };
    }
    const selfOption: PlacementOption = {
      environmentId: self.environmentId,
      label: self.label,
      report: self,
      receivedAt: now,
      sentLaunches: 0,
      warmth:
        request.instanceId !== undefined && !self.providers.includes(request.instanceId)
          ? { unavailable: `does not run ${request.instanceId}` }
          : match.kind === "world" && !self.worlds.includes(match.world)
            ? { unavailable: `does not serve the ${match.world} world` }
            : 1,
    };
    const enabled = yield* links.enabled;
    const peerEntries = enabled ? [...(yield* Ref.get(peers)).entries()] : [];
    const peerOptions = yield* Effect.forEach(
      peerEntries,
      ([environmentId, state]) =>
        peerOption(environmentId, state, match, request.instanceId, now).pipe(
          Effect.map((found) => ({ environmentId, ...found })),
        ),
      { concurrency: "unbounded" },
    );
    const targets = new Map(
      peerOptions.flatMap((entry) =>
        entry.target === null ? [] : [[entry.environmentId, entry.target] as const],
      ),
    );
    // Scored after the probes, so a slow probe's fresh report never reads as from the future.
    const decision = decidePlacement(
      [selfOption, ...peerOptions.map((entry) => entry.option)],
      yield* Clock.currentTimeMillis,
    );
    if (decision === null && match.kind === "world" && !self.worlds.includes(match.world)) {
      // Nobody placed it, and this host cannot run it either.
      return yield* failure(
        [self, ...peerOptions.map((entry) => entry.option.report)].some((report) =>
          report?.worlds.includes(match.world),
        )
          ? `No machine that serves the ${match.world} world takes placed threads.`
          : `No linked machine serves the ${match.world} world.`,
      );
    }
    return { decision, self, decidedAt, decidedBy, stays: null, targets };
  });

  const placementOf = (
    decided: Effect.Success<ReturnType<typeof decideFor>>,
    chosen: PlacementCandidate,
    reason: string,
    wait: boolean,
    candidates: ReadonlyArray<PlacementCandidate>,
  ): ThreadPlacement => ({
    decidedBy: decided.decidedBy,
    environmentId: chosen.environmentId,
    label: chosen.label,
    reason,
    candidates: [...candidates],
    decidedAt: DateTime.formatIso(decided.decidedAt),
    waitingSince: wait ? DateTime.formatIso(decided.decidedAt) : null,
  });

  const preview: Placement["Service"]["preview"] = Effect.fn("Placement.preview")(
    function* (request) {
      const decided = yield* decideFor(request);
      if (decided.decision === null) return null;
      const { chosen, reason, wait, candidates } = decided.decision;
      return { environmentId: chosen.environmentId, label: chosen.label, reason, wait, candidates };
    },
  );

  const decideNow = Effect.fn("Placement.decideNow")(function* (request: PlacementRequest) {
    const decided = yield* decideFor(request);
    if (decided.decision === null) {
      const self: PlacementCandidate = {
        environmentId: decided.self.environmentId,
        label: decided.self.label,
        score: 0,
        slots: 0,
        warmth: 1,
        admissible: true,
        note: null,
      };
      return {
        _tag: "Here",
        // A launch that stays says why; one nobody can take runs here as it would without placement.
        placement:
          decided.stays === null
            ? undefined
            : placementOf(decided, self, `stays here: ${decided.stays}`, false, []),
      } as const;
    }
    const { chosen, reason, wait, candidates } = decided.decision;
    const placement = placementOf(decided, chosen, reason, wait, candidates);
    if (chosen.environmentId === decided.self.environmentId) {
      return { _tag: "Here", placement } as const;
    }
    const target = decided.targets.get(chosen.environmentId);
    if (target === undefined) {
      return yield* failure(`${chosen.label} has no project for this thread.`);
    }
    const now = yield* Clock.currentTimeMillis;
    const sentLaunch: SentLaunch = { at: now, acceptedAt: undefined };
    sent.set(chosen.environmentId, [
      ...(sent.get(chosen.environmentId) ?? []).filter(
        (launch) => now - launch.at < SENT_LAUNCH_TTL_MS,
      ),
      sentLaunch,
    ]);
    const choice = {
      _tag: "Peer",
      environmentId: chosen.environmentId,
      target,
      placement,
    } as const;
    sentByChoice.set(choice, sentLaunch);
    return choice;
  });

  // A retried launch keeps the machine its first attempt picked, so it never starts twice,
  // also when the retry arrives while the first is still deciding.
  const decisions = new Map<
    string,
    { readonly choice: Deferred.Deferred<PlacementChoice, PlacementError>; readonly at: number }
  >();

  const decide: Placement["Service"]["decide"] = Effect.fn("Placement.decide")(
    function* (request, key) {
      if (key === undefined) return yield* decideNow(request);
      const now = yield* Clock.currentTimeMillis;
      for (const [stale, entry] of decisions) {
        if (now - entry.at > DECISION_TTL_MS) decisions.delete(stale);
      }
      const known = decisions.get(key);
      if (known !== undefined) {
        // A first attempt that failed or was interrupted left nothing to reuse: decide again.
        const reused = yield* Deferred.await(known.choice).pipe(
          Effect.catchCause(() => decide(request, key)),
        );
        const refusal = retryRefusal(reused, request);
        return refusal === null ? reused : yield* failure(refusal);
      }
      const choice = yield* Deferred.make<PlacementChoice, PlacementError>();
      // Publishing the pending entry and its finalizer cannot be split by an interruption, or
      // every retry with this key would wait on an entry nobody completes.
      return yield* Effect.uninterruptibleMask((restore) => {
        // Pending decisions never expire; a finished one does, counted from when it finished.
        decisions.set(key, { choice, at: Number.POSITIVE_INFINITY });
        return restore(decideNow(request)).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (exit._tag === "Success") {
                decisions.set(key, { choice, at: yield* Clock.currentTimeMillis });
              } else {
                decisions.delete(key);
              }
              yield* Deferred.done(choice, exit);
            }),
          ),
        );
      });
    },
  );

  const launchOnPeer: Placement["Service"]["launchOnPeer"] = Effect.fn("Placement.launchOnPeer")(
    function* (choice, args, limits, origin) {
      const placement = yield* encodePlacement(choice.placement).pipe(
        Effect.mapError(() => failure("Could not encode the placement.")),
      );
      const body = yield* post(
        choice.environmentId,
        PLACEMENT_LAUNCH_PATH,
        {
          arguments: { ...args, ...choice.target },
          placement,
          ...(origin === undefined ? {} : { origin }),
        },
        LAUNCH_TIMEOUT,
        limits,
      );
      const decoded = yield* decodeLaunchResult(body).pipe(
        Effect.mapError(() =>
          failure(`${choice.placement.label} answered in an unexpected shape.`),
        ),
      );
      if (decoded.result === undefined) {
        const refusal = decoded.error === undefined ? undefined : decodeRefusal(decoded.error);
        return yield* failure(
          refusal?._tag === "Some"
            ? refusal.value.message
            : (decoded.error ?? `${choice.placement.label} did not start the thread.`),
        );
      }
      const launched = yield* decodeLaunched(decoded.result).pipe(
        Effect.mapError(() =>
          failure(`${choice.placement.label} answered in an unexpected shape.`),
        ),
      );
      const sentLaunch = sentByChoice.get(choice);
      if (sentLaunch !== undefined) sentLaunch.acceptedAt = yield* Clock.currentTimeMillis;
      return { threadId: launched.threadId, result: decoded.result };
    },
  );

  const launch: Placement["Service"]["launch"] = Effect.fn("Placement.launch")(function* (input) {
    // Filling a draft thread that exists here keeps it here.
    const choice: PlacementChoice =
      input.reuseExistingThread === true
        ? { _tag: "Here", placement: undefined }
        : yield* decide(
            {
              projectId: input.projectId,
              instanceId: input.modelSelection.instanceId,
              workspaceStrategy: input.workspaceStrategy,
              hasAttachments: (input.initialMessage?.attachments.length ?? 0) > 0,
              hasContext: (input.initialMessage?.context?.records.length ?? 0) > 0,
            },
            `launch:${input.commandId}`,
          );
    if (choice._tag === "Here") {
      const launched = yield* ThreadMessageIntake.launchThread({
        ...input,
        ...(choice.placement === undefined ? {} : { placement: choice.placement }),
      }).pipe(Effect.provide(intakeContext));
      // As stored: admission here may have made it wait.
      const placement = launched.projection.thread.placement;
      return {
        environmentId: placement?.environmentId ?? (yield* local.report()).environmentId,
        threadId: launched.threadId,
        placement,
      };
    }
    const { threadId, result } = yield* launchOnPeer(
      choice,
      {
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode,
        interactionMode: input.interactionMode,
        ...("scratch" in choice.target ? {} : { workspaceStrategy: input.workspaceStrategy }),
        ...(input.initialMessage === undefined ? {} : { message: input.initialMessage.text }),
        clientRequestId: input.commandId,
      },
      { runtimeMode: input.runtimeMode, interactionMode: input.interactionMode },
      {
        creationSource: input.creationSource,
        ...(input.generateTitle === undefined ? {} : { generateTitle: input.generateTitle }),
      },
    );
    // Its workspace is prepared there; nothing here waits on it.
    if (input.preparation !== undefined) yield* Deferred.succeed(input.preparation, undefined);
    // The peer's admission may have made it wait; its answer says so.
    const stored = decodeLaunchedPlacement(result);
    const placement: ThreadPlacement =
      stored._tag === "Some" && stored.value.placement !== undefined
        ? {
            ...choice.placement,
            reason: stored.value.placement.reason,
            waitingSince: stored.value.placement.waitingForRoom
              ? (choice.placement.waitingSince ?? DateTime.formatIso(yield* DateTime.now))
              : null,
          }
        : choice.placement;
    return { environmentId: choice.environmentId, threadId, placement };
  });

  const abandon: Placement["Service"]["abandon"] = (choice) =>
    Effect.sync(() => {
      const sentLaunch = sentByChoice.get(choice);
      if (sentLaunch === undefined || sentLaunch.acceptedAt !== undefined) return;
      sent.set(
        choice.environmentId,
        (sent.get(choice.environmentId) ?? []).filter((launch) => launch !== sentLaunch),
      );
    });

  return Placement.of({ preview, decide, abandon, launchOnPeer, launch, start });
});

export const layer = Layer.effect(Placement, make);
