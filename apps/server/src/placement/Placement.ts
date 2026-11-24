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
  type PlacementHydrateRequest,
  PlacementHydrateResult,
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
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
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
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as LocalPlacement from "./LocalPlacement.ts";

export const PLACEMENT_REPORT_PATH = "/mcp/placement/report";
export const PLACEMENT_LAUNCH_PATH = "/mcp/placement/launch";
export const PLACEMENT_HYDRATE_PATH = "/mcp/placement/hydrate";

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
// Outlasts a cold clone and the launch after it, so a retry never lands somewhere new mid-way.
const DECISION_TTL_MS = 30 * 60_000;
// A host that has to clone first is worth half of one that has the repository.
const COLD_WARMTH = 0.5;
// A clone that borrows a worlds mirror takes seconds; a cold clone of a large repository minutes.
export const HYDRATE_TIMEOUT_MS = 15 * 60_000;
// Each hydrate request stays well under a relay's idle limit; the host answers "pending" meanwhile.
const HYDRATE_REQUEST_TIMEOUT = Duration.seconds(45);
const HYDRATE_RETRY_PAUSE = Duration.seconds(5);
// A host that failed to clone a repository is not asked to clone it again for this long.
const CLONE_FAILURE_TTL_MS = 10 * 60_000;

/** What a launch needs, so placement knows which machines can take it. */
export interface PlacementRequest {
  /** The project here, or null for a new Scratch folder. */
  readonly projectId: ProjectId | null;
  /** Machines without this provider instance are left out; any machine when absent. */
  readonly instanceId: ProviderInstanceId | undefined;
  readonly workspaceStrategy: ThreadLaunch.ThreadLaunchWorkspaceStrategy;
  readonly hasAttachments: boolean;
  readonly hasContext: boolean;
  /**
   * Whether the launch may make a peer clone a repository, which adds a project there: only a
   * caller at full access and default interaction may, as for `t3_project_clone`.
   */
  readonly mayClone: boolean;
}

type ModeLimits = {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
};

/** Whether a caller with these modes may make a peer clone a repository. */
export const limitsMayClone = (limits: ModeLimits) =>
  limits.runtimeMode === "full-access" && limits.interactionMode === "default";

export type PlacementChoice =
  | { readonly _tag: "Here"; readonly placement: ThreadPlacement | undefined }
  | {
      readonly _tag: "Peer";
      readonly environmentId: EnvironmentId;
      /** Where the thread goes there: a project, or a new Scratch folder. */
      readonly target:
        | { readonly projectId: ProjectId }
        | { readonly scratch: true }
        /** A host without the repository, which clones it before the launch (decision 2). */
        | {
            readonly clone: Omit<PlacementHydrateRequest, "files" | "requestId" | "poll"> & {
              readonly sourceRoot: string;
            };
          };
      readonly placement: ThreadPlacement;
    };

const PeerLaunchResult = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
const decodeLaunched = Schema.decodeUnknownEffect(Schema.Struct({ threadId: ThreadId }));
const decodeJsonBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeHydrateResult = Schema.decodeUnknownEffect(
  Schema.Struct({
    result: Schema.optional(PlacementHydrateResult),
    error: Schema.optional(Schema.String),
    /** Still cloning: ask again with the same request. */
    pending: Schema.optional(Schema.Boolean),
  }),
);
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
    /** Where the thread goes on the chosen peer, cloning the repository there first if needed. */
    readonly prepareTarget: (
      choice: Extract<PlacementChoice, { _tag: "Peer" }>,
      /** The caller's current modes, read again just before files are sent. */
      readLimits: Effect.Effect<ModeLimits, PlacementError>,
    ) => Effect.Effect<
      { readonly projectId: ProjectId } | { readonly scratch: true },
      PlacementError
    >;
    /** Runs `t3_thread_launch` on the chosen peer with the placement stamped on the thread. */
    /** Whether the run that asked for a launch still runs, with no stop asked for it. */
    readonly runIsLive: (runId: RunId | null) => Effect.Effect<boolean>;
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
      /** The modes a clone there is asked for with; the launch's own by default. */
      cloneLimits?: ModeLimits,
      /** Checked once the peer's link resolves, right before the launch is sent. */
      beforeSend?: Effect.Effect<void, PlacementError>,
    ) => Effect.Effect<{ readonly threadId: ThreadId; readonly result: unknown }, PlacementError>;
    /** An auto launch from a client or a scheduled task: here, or on the peer placement picks. */
    readonly launch: (
      input: ThreadLaunch.ThreadLaunchInput,
      /** Whether the launch may clone on a peer; by default the user's own launches may. */
      options?: { readonly mayClone?: boolean },
    ) => Effect.Effect<
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
  /** A clone writes a project there, which only a full-access link may ask for. */
  readonly fullAccess: boolean;
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
  /** Renewed once a clone for it finishes, so the launch counts while it is sent. */
  at: number;
  /** Released before it was sent; never renewed after that. */
  abandoned?: true;
  /** When the peer created the thread; a report asked for after that counts it. */
  acceptedAt: number | undefined;
}

/** A remote URL without a user's password or token, as a peer may see it. */
export function withoutCredentials(remoteUrl: string): string {
  const parsed = URL.parse(remoteUrl);
  if (parsed === null) return remoteUrl;
  // Over https a token often sits in the user name; over ssh the user name is the login.
  const web = parsed.protocol === "https:" || parsed.protocol === "http:";
  if (web) parsed.username = "";
  parsed.password = "";
  // Some forges take a token as a query parameter.
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/** A repository key every peer may see: a key the resolver fell back to from a URL may not be. */
export const shareableRepositoryKey = (key: string) => (/[@?#]|:\/\//.test(key) ? null : key);

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
  const entries = yield* WorkspaceEntries.WorkspaceEntries;
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const links = yield* PeerLinks.PeerLinks;
  // A redirect could forward a link's token or a clone's env files to another origin.
  const httpClient = HttpClient.transform(yield* HttpClient.HttpClient, (response) =>
    Effect.provideService(response, FetchHttpClient.RequestInit, { redirect: "manual" }),
  );
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
  const cloneFailures = new Map<string, number>();
  // Peer choices whose clone failed before anything launched there.
  const failedClones = new WeakSet<object>();
  const hydrations = new WeakMap<object, Deferred.Deferred<ProjectId, PlacementError>>();
  const random = yield* SecureRandom.SecureRandom;
  const cloneFailedRecently = (environmentId: EnvironmentId, repository: string, now: number) =>
    now - (cloneFailures.get(`${environmentId} ${repository}`) ?? -Infinity) < CLONE_FAILURE_TTL_MS;

  const failure = (message: string) => new PlacementError({ message });
  // A request that got no answer may still have arrived; one that can be repeated is repeated.
  const silentFailures = new WeakSet<PlacementError>();
  // Refusals by the caller or its link, which say nothing about the host's clone.
  const callerRefusals = new WeakSet<PlacementError>();
  const silent = (message: string) => {
    const error = failure(message);
    silentFailures.add(error);
    return error;
  };

  // Resolved before every request: the link sends its token only to an address that still
  // answers as that peer.
  const resolve = (environmentId: EnvironmentId) =>
    links.resolve(environmentId).pipe(Effect.mapError((error) => failure(error.message)));

  const post = Effect.fn("Placement.post")(function* (
    to: EnvironmentId | Effect.Success<ReturnType<typeof resolve>>,
    path: string,
    body: unknown,
    timeout: Duration.Input,
    limits?: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
    /** Checked after the link resolves, which can take seconds, right before sending. */
    beforeSend: (
      link: Effect.Success<ReturnType<typeof resolve>>,
    ) => Effect.Effect<void, PlacementError> = () => Effect.void,
  ) {
    const link = typeof to === "string" ? yield* resolve(to) : to;
    yield* beforeSend(link);
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
      Effect.mapError(() => silent(`${link.link.label} did not answer.`)),
    );
    if (response.status !== 200) {
      const refusal = failure(`${link.link.label} answered HTTP ${response.status}.`);
      // The link was refused there, which says nothing about a clone on that host.
      if (response.status === 401 || response.status === 403) callerRefusals.add(refusal);
      return yield* refusal;
    }
    // A peer that sends headers and then stalls or drops the body must not hold a decision
    // either; a body that arrived whole but is not JSON is an answer, not a lost one.
    const text = yield* response.text.pipe(
      Effect.timeout(timeout),
      Effect.mapError(() => silent(`${link.link.label} did not finish answering.`)),
    );
    return yield* decodeJsonBody(text).pipe(
      Effect.mapError(() => failure(`${link.link.label} answered in an unexpected shape.`)),
    );
  });

  /**
   * The resolved link is still the one stored, with Linked environments on: resolving can take
   * seconds, in which the user may unlink, re-pair or turn links off.
   */
  const confirmLink = Effect.fn("Placement.confirmLink")(function* (
    link: Effect.Success<ReturnType<typeof resolve>>,
    access?: "full-access",
  ) {
    const enabled = yield* links.enabled;
    // Read last, right before the send: whether the user still has this link.
    const stored = yield* links.get(link.link.environmentId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    if (
      !enabled ||
      stored === undefined ||
      DateTime.toEpochMillis(stored.linkedAt) !== DateTime.toEpochMillis(link.link.linkedAt) ||
      (access !== undefined && stored.access !== access)
    ) {
      return yield* failure(`${link.link.label} is no longer linked as it was.`);
    }
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
      // The clone URL goes only to the machine that clones, in the hydrate request.
      encodeReportRequest(
        match === undefined
          ? {}
          : { match: match.kind === "repo" ? { ...match, remoteUrl: undefined } : match },
      ),
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
            fullAccess: current.get(environmentId)?.fullAccess ?? false,
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
        const known = current.get(link.environmentId);
        next.set(link.environmentId, {
          label: known?.label ?? link.label,
          report: known?.report ?? null,
          receivedAt: known?.receivedAt ?? 0,
          askedAt: known?.askedAt ?? 0,
          fullAccess: link.access === "full-access",
        });
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
    // The key the sidebar groups copies by: a fork's own remote, not its upstream.
    const repository =
      identity === null ? null : shareableRepositoryKey(repositoryGroupingKeyOf(identity));
    return identity === null || repository === null
      ? null
      : ({
          kind: "repo",
          repository,
          path: LocalPlacement.repositoryFolder(
            path.relative(identity.rootPath ?? project.workspaceRoot, project.workspaceRoot),
          ),
          remoteUrl: withoutCredentials(identity.origin?.remoteUrl ?? identity.locator.remoteUrl),
        } as const);
  });

  /** The local project a repository thread comes from, for a host that has to clone it. */
  const cloneSourceFor = Effect.fn("Placement.cloneSourceFor")(function* (projectId: ProjectId) {
    const project = Option.getOrUndefined(
      yield* projects.getById(projectId).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    return project === undefined
      ? undefined
      : { title: project.title, root: project.workspaceRoot };
  });

  const peerOption = Effect.fn("Placement.peerOption")(function* (
    environmentId: EnvironmentId,
    state: PeerState,
    match: PlacementMatch,
    instanceId: ProviderInstanceId | undefined,
    now: number,
    cloneSource: { readonly title: string; readonly root: string } | undefined,
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
    // A host without the repository clones it from the remote when the thread lands there.
    const clonable =
      match.kind === "repo" &&
      match.remoteUrl !== undefined &&
      cloneSource !== undefined &&
      state.fullAccess &&
      report?.canClone === true &&
      !cloneFailedRecently(environmentId, match.repository, now);
    const warmth =
      report === null
        ? 1
        : !answered
          ? unavailable("did not say whether it has the project")
          : instanceId !== undefined && !report.providers.includes(instanceId)
            ? unavailable(`does not run ${instanceId}`)
            : match.kind === "world" && !report.worlds.includes(match.world)
              ? unavailable(`does not serve the ${match.world} world`)
              : match.kind === "repo" && projectId === null && clonable
                ? COLD_WARMTH
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
          : projectId !== null
            ? { projectId }
            : clonable && match.kind === "repo" && match.remoteUrl !== undefined && cloneSource
              ? {
                  clone: {
                    repository: match.repository,
                    path: match.path ?? "",
                    remoteUrl: match.remoteUrl,
                    title: cloneSource.title,
                    sourceRoot: cloneSource.root,
                  },
                }
              : null,
    };
  });

  const decideFor = Effect.fn("Placement.decideFor")(function* (request: PlacementRequest) {
    const self = yield* local.report();
    const decidedAt = yield* DateTime.now;
    const now = DateTime.toEpochMillis(decidedAt);
    const decidedBy = { environmentId: self.environmentId, label: self.label };
    const stays = staysHere(request);
    const match = stays === null ? yield* matchFor(request.projectId) : null;
    const cloneSource =
      match?.kind === "repo" && request.projectId !== null
        ? yield* cloneSourceFor(request.projectId)
        : undefined;
    if (match === null) {
      return {
        decision: null,
        self,
        decidedAt,
        decidedBy,
        stays: stays ?? "its project has no remote repository it can share",
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
        peerOption(
          environmentId,
          state,
          match,
          request.instanceId,
          now,
          // Without a source no peer is a cold candidate.
          request.mayClone ? cloneSource : undefined,
        ).pipe(Effect.map((found) => ({ environmentId, ...found }))),
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
  type Decision = {
    readonly choice: Deferred.Deferred<PlacementChoice, PlacementError>;
    readonly at: number;
  };
  const decisions = new Map<string, Decision>();
  type Claimed =
    | { readonly _tag: "Known"; readonly known: Decision }
    | { readonly _tag: "Decided"; readonly decided: PlacementChoice };

  const decide: Placement["Service"]["decide"] = Effect.fn("Placement.decide")(
    function* (request, key) {
      if (key === undefined) return yield* decideNow(request);
      const now = yield* Clock.currentTimeMillis;
      for (const [stale, entry] of decisions) {
        if (now - entry.at > DECISION_TTL_MS) decisions.delete(stale);
      }
      // Looked up and, when missing, published as pending in one step with no yield between, or
      // two attempts with one key could both decide. An interruption cannot split it either.
      const claimed = yield* Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const known = decisions.get(key);
          if (known !== undefined) return Effect.succeed<Claimed>({ _tag: "Known", known });
          const choice = Deferred.makeUnsafe<PlacementChoice, PlacementError>();
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
            Effect.map((decided): Claimed => ({ _tag: "Decided", decided })),
          );
        }),
      );
      if (claimed._tag === "Decided") return claimed.decided;
      const known = claimed.known;
      // A first attempt that failed or was interrupted left nothing to reuse: decide again.
      const reused = yield* Deferred.await(known.choice).pipe(Effect.exit);
      // So did one whose clone failed: nothing launched there, so another machine may take it.
      if (Exit.isSuccess(reused) && !failedClones.has(reused.value)) {
        const refusal = retryRefusal(reused.value, request);
        return refusal === null ? reused.value : yield* failure(refusal);
      }
      if (decisions.get(key) === known) decisions.delete(key);
      return yield* decide(request, key);
    },
  );

  const recordCloneFailure = (environmentId: EnvironmentId, repository: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => void cloneFailures.set(`${environmentId} ${repository}`, now)),
    );

  /** The env files of the project a clone comes from: its git-ignored `.env` family. */
  const copiedFiles = Effect.fn("Placement.copiedFiles")(function* (sourceRoot: string) {
    const listed = yield* entries
      .listIgnoredFiles({ cwd: sourceRoot })
      .pipe(Effect.orElseSucceed(() => ({ files: [], truncated: false })));
    const wanted = listed.files.filter(
      (file) =>
        file.byteLength <= LocalPlacement.COPIED_FILE_MAX_BYTES &&
        LocalPlacement.COPIED_FILE_NAME.test(path.basename(file.path)),
    );
    return yield* Effect.forEach(wanted, (file) =>
      fs.readFile(path.join(sourceRoot, file.path)).pipe(
        Effect.map((bytes) => [
          { path: file.path, contents: Buffer.from(bytes).toString("base64") },
        ]),
        Effect.orElseSucceed(() => []),
      ),
    ).pipe(Effect.map((files) => files.flat()));
  });

  /** Clones the repository on the chosen peer, sending the source project's env files. */
  const hydrate = Effect.fn("Placement.hydrate")(function* (
    choice: Extract<PlacementChoice, { _tag: "Peer" }>,
    clone: Omit<PlacementHydrateRequest, "files" | "requestId" | "poll">,
    sourceRoot: string,
    readLimits: Effect.Effect<ModeLimits, PlacementError>,
  ) {
    const files = yield* copiedFiles(sourceRoot);
    const requestId = yield* random.uuidV4();
    const deadline = (yield* Clock.currentTimeMillis) + HYDRATE_TIMEOUT_MS;
    const tooLong = failure(`${choice.placement.label} took too long to clone the repository.`);
    // The caller or the link said no, not the host: it does not sit out cold placement.
    const refusedHere = (message: string) => {
      const refusal = failure(message);
      callerRefusals.add(refusal);
      return Effect.fail(refusal);
    };
    // Whether the host answered once, so it holds this clone and the files went with it.
    let started = false;
    while (true) {
      const left = deadline - (yield* Clock.currentTimeMillis);
      if (left <= 0) return yield* tooLong;
      const answered = yield* Effect.gen(function* () {
        // A peer that cannot be reached now may answer the next request; an unlinked, expired or
        // refused link will not, and says nothing about the host's clone.
        const link = yield* links.resolve(choice.environmentId).pipe(
          Effect.mapError((error) => {
            const refusal = failure(error.message);
            (error.reason === "unreachable" ? silentFailures : callerRefusals).add(refusal);
            return refusal;
          }),
        );
        // Checked after resolving, which can take seconds: the caller as it is now, then the
        // link as stored (not removed, re-paired or lowered) right before sending.
        if (link.link.access !== "full-access") {
          return yield* refusedHere(
            `${link.link.label} may not clone repositories over this link.`,
          );
        }
        const limits = yield* readLimits.pipe(
          Effect.tapError((error) => Effect.sync(() => callerRefusals.add(error))),
        );
        if (!limitsMayClone(limits)) {
          return yield* refusedHere(
            "Only a launch at full access may clone a repository elsewhere.",
          );
        }
        // Last, as the caller check reads the database: the link as stored right before sending.
        yield* confirmLink(link, "full-access").pipe(
          Effect.tapError((error) => Effect.sync(() => callerRefusals.add(error))),
        );
        // Only the first request carries files.
        return yield* post(
          link,
          PLACEMENT_HYDRATE_PATH,
          started ? { ...clone, files: [], requestId, poll: true } : { ...clone, files, requestId },
          HYDRATE_REQUEST_TIMEOUT,
          limits,
        );
      }).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => silentFailures.has(error),
          () => Effect.succeedNone,
        ),
        // An answer after the deadline still counts; a request that runs past it does not.
        Effect.timeoutOrElse({
          duration: Duration.millis(left),
          orElse: () => tooLong,
        }),
      );
      if (Option.isSome(answered)) {
        const answer = yield* decodeHydrateResult(answered.value).pipe(
          Effect.mapError(() =>
            failure(`${choice.placement.label} answered in an unexpected shape.`),
          ),
        );
        if (answer.result !== undefined) return answer.result.projectId;
        if (answer.pending !== true) {
          return yield* failure(
            answer.error ?? `${choice.placement.label} could not clone the repository.`,
          );
        }
        started = true;
      }
      // A lost answer is asked for again after a pause; a pending one at once.
      if (Option.isNone(answered)) {
        const pause = Math.min(
          Duration.toMillis(HYDRATE_RETRY_PAUSE),
          deadline - (yield* Clock.currentTimeMillis),
        );
        if (pause > 0) yield* Effect.sleep(Duration.millis(pause));
      }
    }
  });

  const prepareTarget: Placement["Service"]["prepareTarget"] = Effect.fn("Placement.prepareTarget")(
    function* (choice, readLimits) {
      if (!("clone" in choice.target)) return choice.target;
      const { sourceRoot, ...clone } = choice.target.clone;
      const projectId = yield* Effect.uninterruptibleMask((restore) =>
        // One clone per choice, claimed in one step: a retry waits for it, so a launch it
        // already sent keeps its machine.
        Effect.sync(() => {
          const known = hydrations.get(choice);
          if (known !== undefined) return { done: known, owner: false };
          const started = Deferred.makeUnsafe<ProjectId, PlacementError>();
          hydrations.set(choice, started);
          return { done: started, owner: true };
        }).pipe(
          Effect.flatMap(({ done, owner }) =>
            !owner
              ? restore(Deferred.await(done))
              : restore(hydrate(choice, clone, sourceRoot, readLimits)).pipe(
                  Effect.onExit((exit) =>
                    Effect.gen(function* () {
                      if (exit._tag === "Success") {
                        // The host is warm for this repository from now on, newer than any probe
                        // that asked before the clone finished.
                        recordMatch(
                          matches,
                          `${choice.environmentId} ${matchKey({ kind: "repo", repository: clone.repository, path: clone.path })}`,
                          {
                            projectId: exit.value,
                            at: yield* Clock.currentTimeMillis,
                            askedAt: ++probes,
                          },
                        );
                      } else {
                        // Nothing launched there yet: a retry of this launch decides again, and
                        // a host that failed the clone sits out cold placement for this repository.
                        // A caller or link refusal and an interruption skip the cooldown: neither
                        // says the host's clone failed.
                        const error = Cause.findErrorOption(exit.cause);
                        if (Option.isSome(error) && !callerRefusals.has(error.value)) {
                          yield* recordCloneFailure(choice.environmentId, clone.repository);
                        }
                        failedClones.add(choice);
                      }
                      yield* Deferred.done(done, exit);
                    }),
                  ),
                ),
          ),
        ),
      );
      // The clone may have outlasted the launch's reservation; it counts again until it is sent.
      // Checked and renewed in one step after the clock read, so an abandon cannot slip between.
      const renewedAt = yield* Clock.currentTimeMillis;
      const sentLaunch = sentByChoice.get(choice);
      if (
        sentLaunch !== undefined &&
        sentLaunch.acceptedAt === undefined &&
        sentLaunch.abandoned !== true
      ) {
        sentLaunch.at = renewedAt;
        const counted = sent.get(choice.environmentId) ?? [];
        if (!counted.includes(sentLaunch)) {
          sent.set(choice.environmentId, [...counted, sentLaunch]);
        }
      }
      return { projectId };
    },
  );

  const launchOnPeer: Placement["Service"]["launchOnPeer"] = Effect.fn("Placement.launchOnPeer")(
    function* (choice, args, limits, origin, cloneLimits, beforeSend) {
      const target = yield* prepareTarget(choice, Effect.succeed(cloneLimits ?? limits));
      const placement = yield* encodePlacement(choice.placement).pipe(
        Effect.mapError(() => failure("Could not encode the placement.")),
      );
      const body = yield* post(
        choice.environmentId,
        PLACEMENT_LAUNCH_PATH,
        {
          arguments: { ...args, ...target },
          placement,
          ...(origin === undefined ? {} : { origin }),
        },
        LAUNCH_TIMEOUT,
        limits,
        // The launch goes out only over the link as stored, and once the caller still asks.
        (link) => (beforeSend ?? Effect.void).pipe(Effect.andThen(confirmLink(link))),
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

  const launch: Placement["Service"]["launch"] = Effect.fn("Placement.launch")(
    function* (input, options) {
      // The user may add a project anywhere; an agent's scheduled launch only within its modes.
      const userLaunch = input.createdBy === "user";
      const mayClone = options?.mayClone ?? (userLaunch || limitsMayClone(input));
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
                mayClone,
              },
              `launch:${input.commandId}`,
            );
      // A retry reuses its first decision, which may be a clone this session may not start.
      // The reservation stays with the attempt that may clone, which may still be running.
      if (choice._tag === "Peer" && "clone" in choice.target && !mayClone) {
        return yield* failure("Starting it there needs a clone this session may not make.");
      }
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
        mayClone && userLaunch
          ? { runtimeMode: "full-access", interactionMode: "default" }
          : undefined,
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
    },
  );

  const runIsLive: Placement["Service"]["runIsLive"] = (runId) =>
    runId === null
      ? Effect.succeed(false)
      : sql<{ readonly status: string; readonly stop_requested: number }>`
          SELECT runs.status,
            EXISTS (
              SELECT 1 FROM orchestration_v2_projection_turn_items stop_request
              WHERE stop_request.thread_id = runs.thread_id AND stop_request.run_id = runs.run_id
                AND stop_request.type = 'run_interrupt_request'
            ) AS stop_requested
          FROM orchestration_v2_projection_runs runs
          WHERE runs.run_id = ${runId}
        `.pipe(
          Effect.map(
            ([run]) =>
              run !== undefined &&
              ["preparing", "queued", "starting", "running", "waiting"].includes(run.status) &&
              !run.stop_requested,
          ),
          Effect.orElseSucceed(() => false),
        );

  const abandon: Placement["Service"]["abandon"] = (choice) =>
    Effect.sync(() => {
      const sentLaunch = sentByChoice.get(choice);
      if (sentLaunch === undefined || sentLaunch.acceptedAt !== undefined) return;
      sentLaunch.abandoned = true;
      sent.set(
        choice.environmentId,
        (sent.get(choice.environmentId) ?? []).filter((launch) => launch !== sentLaunch),
      );
    });

  return Placement.of({
    preview,
    decide,
    runIsLive,
    abandon,
    prepareTarget,
    launchOnPeer,
    launch,
    start,
  });
});

export const layer = Layer.effect(Placement, make);
