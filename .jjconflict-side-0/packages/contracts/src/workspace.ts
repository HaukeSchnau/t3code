import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  ThreadWorkspaceId,
  ThreadWorkspaceRootId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { VcsDriverKind } from "./vcs.ts";

export const ThreadWorkspaceKind = Schema.Literals([
  "local",
  "git-detached",
  "jj-workspace",
  "directory-copy",
]);
export type ThreadWorkspaceKind = typeof ThreadWorkspaceKind.Type;

export const ThreadWorkspaceLifecycle = Schema.Literals([
  "preparing",
  "active",
  "deleting",
  "deleted",
  "failed",
]);
export type ThreadWorkspaceLifecycle = typeof ThreadWorkspaceLifecycle.Type;

export const ThreadWorkspaceRetentionPolicy = Schema.Literals(["explicit-delete", "permanent"]);
export type ThreadWorkspaceRetentionPolicy = typeof ThreadWorkspaceRetentionPolicy.Type;

export const ThreadWorkspaceRootRole = Schema.Literals(["primary", "supporting"]);
export type ThreadWorkspaceRootRole = typeof ThreadWorkspaceRootRole.Type;

export const ThreadWorkspaceRoot = Schema.Struct({
  id: ThreadWorkspaceRootId,
  workspaceId: ThreadWorkspaceId,
  projectId: ProjectId,
  role: ThreadWorkspaceRootRole,
  sourcePath: TrimmedNonEmptyString,
  checkoutPath: TrimmedNonEmptyString,
  vcsKind: VcsDriverKind,
  repositoryRoot: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  baseRevision: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  headRevision: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type ThreadWorkspaceRoot = typeof ThreadWorkspaceRoot.Type;

export const ThreadWorkspace = Schema.Struct({
  id: ThreadWorkspaceId,
  kind: ThreadWorkspaceKind,
  lifecycle: ThreadWorkspaceLifecycle,
  displayName: TrimmedNonEmptyString,
  managed: Schema.Boolean,
  primaryRootId: ThreadWorkspaceRootId,
  roots: Schema.Array(ThreadWorkspaceRoot),
  createdForThreadId: Schema.NullOr(ThreadId),
  retentionPolicy: ThreadWorkspaceRetentionPolicy,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
  failureDetail: Schema.NullOr(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type ThreadWorkspace = typeof ThreadWorkspace.Type;
