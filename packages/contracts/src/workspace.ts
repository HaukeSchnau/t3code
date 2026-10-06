import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** What an isolated workspace starts with: global instructions and skills, or project guidance only. */
export const WorkspaceProfile = Schema.Literals(["familiar", "minimal"]);
export type WorkspaceProfile = typeof WorkspaceProfile.Type;

/**
 * A new workspace whose backend the server chooses for the project: a jj workspace, a
 * guarded directory copy, an isolated runtime, or a Git worktree for plain Git projects.
 */
export const ManagedWorkspaceLaunchStrategy = Schema.Struct({
  type: Schema.Literal("workspace"),
  baseRef: Schema.optional(TrimmedNonEmptyString),
  startFromOrigin: Schema.optional(Schema.Boolean),
  profile: Schema.optional(WorkspaceProfile),
});
export type ManagedWorkspaceLaunchStrategy = typeof ManagedWorkspaceLaunchStrategy.Type;

/** Present when the server creates workspaces for jj and directory projects too. */
export const ManagedWorkspacesCapability = Schema.Struct({
  /** New workspaces run in separate agent-exec environments and accept a profile. */
  isolated: Schema.Boolean,
});
export type ManagedWorkspacesCapability = typeof ManagedWorkspacesCapability.Type;
