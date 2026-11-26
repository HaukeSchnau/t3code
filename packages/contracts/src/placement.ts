// Fork (patches/fleet-placement.md): placement of new threads across linked environments.
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";
import { WorldId } from "./world.ts";

/** What a new thread needs from a machine, so placement knows which ones can take it. */
export const PlacementMatch = Schema.Union([
  /** Runs in a world: any Linux host that serves it. */
  Schema.Struct({ kind: Schema.Literal("world"), world: WorldId }),
  /** Runs in a repository: warm where the host has a project for it. */
  Schema.Struct({
    kind: Schema.Literal("repo"),
    repository: TrimmedNonEmptyString,
    /** The project's folder below the repository root, "" for the root. */
    path: Schema.optional(Schema.String),
    /** Where a host without the repository clones it from. */
    remoteUrl: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({ kind: Schema.Literal("scratch") }),
]);
export type PlacementMatch = typeof PlacementMatch.Type;

export const PlacementReportRequest = Schema.Struct({
  match: Schema.optional(PlacementMatch),
});
export type PlacementReportRequest = typeof PlacementReportRequest.Type;

/** One environment's load, read by its linked peers every few seconds. */
export const PlacementReport = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  /** `process.platform` of the host. */
  platform: Schema.String,
  /** The host's own placement weight; null until set, 0 for Manual only. */
  weight: Schema.NullOr(NonNegativeInt),
  /** The most agents the host runs at once; null for no limit beyond its memory. */
  agentLimit: Schema.NullOr(PositiveInt),
  resources: HostResourcesSnapshot,
  /** Runs that have started their agent and not ended. */
  runningAgents: NonNegativeInt,
  /** Runs preparing their workspace that will start an agent soon, not counting waiting ones. */
  launchesInFlight: NonNegativeInt,
  /** Threads waiting for room on this host. */
  waiting: NonNegativeInt,
  /** Worlds this host serves to threads. */
  worlds: Schema.Array(WorldId),
  /** Provider instances that are installed and enabled there. */
  providers: Schema.Array(ProviderInstanceId),
  /** The project there for the request's `match`; absent when the request had none. */
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  /** Clones a repository it lacks into a project of its own. Older servers omit it. */
  canClone: Schema.optional(Schema.Boolean),
  /**
   * A T3 release waits for this host to go idle, so it takes no placed threads until the release
   * lands. Older servers omit it.
   */
  updating: Schema.optional(Schema.Boolean),
});
export type PlacementReport = typeof PlacementReport.Type;

export const PlacementCandidate = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  /** weight × free agent slots × warmth; 0 when the machine cannot take the thread now. */
  score: Schema.Number,
  slots: Schema.Number,
  /** 1 when the machine already has what the thread needs. */
  warmth: Schema.Number,
  admissible: Schema.Boolean,
  /** Why the machine scored as it did, such as "memory pressure 34%". */
  note: Schema.NullOr(Schema.String),
});
export type PlacementCandidate = typeof PlacementCandidate.Type;

/** Where a placed thread runs and why, as the deciding environment saw it. */
export const ThreadPlacement = Schema.Struct({
  decidedBy: Schema.Struct({ environmentId: EnvironmentId, label: TrimmedNonEmptyString }),
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  reason: Schema.String,
  candidates: Schema.Array(PlacementCandidate),
  decidedAt: IsoDateTime,
  /** Set while the thread waits for room on its machine. */
  waitingSince: Schema.NullOr(IsoDateTime),
});
export type ThreadPlacement = typeof ThreadPlacement.Type;

export const PlacementPreviewInput = Schema.Struct({
  projectId: ProjectId,
  /** The provider instance the draft will use; machines without it are left out. */
  instanceId: Schema.optional(ProviderInstanceId),
});
export type PlacementPreviewInput = typeof PlacementPreviewInput.Type;

export const PlacementPreview = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  reason: Schema.String,
  /** No machine has room; the thread would wait on this one. */
  wait: Schema.Boolean,
  candidates: Schema.Array(PlacementCandidate),
});
export type PlacementPreview = typeof PlacementPreview.Type;

export const PlacementPreviewResult = Schema.Struct({
  /** Null when placement is off here or no machine can take the thread. */
  preview: Schema.NullOr(PlacementPreview),
});
export type PlacementPreviewResult = typeof PlacementPreviewResult.Type;

export const PlacementLaunchResult = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  /** Absent when no machine takes placed work, so the thread started here as usual. */
  placement: Schema.optional(ThreadPlacement),
});
export type PlacementLaunchResult = typeof PlacementLaunchResult.Type;

export const PlacementStartNowInput = Schema.Struct({
  threadId: ThreadId,
});
export type PlacementStartNowInput = typeof PlacementStartNowInput.Type;

export class PlacementError extends Schema.TaggedError<PlacementError>()("PlacementError", {
  message: Schema.String,
}) {}

/** A git-ignored file copied to a fresh clone, such as `.env`. */
export const PlacementCopiedFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** Base64. */
  contents: Schema.String,
});
export type PlacementCopiedFile = typeof PlacementCopiedFile.Type;

/** Asks a host to clone a repository it lacks, as a project placement can start threads in. */
export const PlacementHydrateRequest = Schema.Struct({
  repository: TrimmedNonEmptyString,
  path: Schema.String,
  remoteUrl: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  files: Schema.Array(PlacementCopiedFile),
  /** Names one clone, so the sender can ask again for its outcome. */
  requestId: Schema.optional(TrimmedNonEmptyString),
  /** Only asks after the clone `requestId` started; it carries no files and starts nothing. */
  poll: Schema.optional(Schema.Boolean),
});
export type PlacementHydrateRequest = typeof PlacementHydrateRequest.Type;

export const PlacementHydrateResult = Schema.Struct({
  projectId: ProjectId,
});
export type PlacementHydrateResult = typeof PlacementHydrateResult.Type;
