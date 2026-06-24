import type * as Effect from "effect/Effect";

import type {
  ThreadWorkspace,
  ThreadWorkspaceKind,
  ThreadWorkspaceRetentionPolicy,
  ThreadWorkspaceRootRole,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import type { PreparedThreadWorkspace, ThreadWorkspaceError } from "./ThreadWorkspaceService.ts";

export interface PrepareThreadWorkspaceRootInput {
  readonly projectId: ProjectId;
  readonly sourcePath: string;
  readonly role: ThreadWorkspaceRootRole;
  readonly baseRevision?: string | null;
  readonly startFromOrigin?: boolean;
}

export interface PrepareThreadWorkspaceInput {
  readonly threadId: ThreadId;
  readonly kind: "auto" | Exclude<ThreadWorkspaceKind, "local">;
  readonly roots: ReadonlyArray<PrepareThreadWorkspaceRootInput>;
  readonly displayNameSeed?: string;
  readonly retentionPolicy?: ThreadWorkspaceRetentionPolicy;
}

export interface ThreadWorkspaceDriver {
  readonly kind: ThreadWorkspaceKind;
  readonly canPrepare: (
    input: PrepareThreadWorkspaceInput,
  ) => Effect.Effect<boolean, ThreadWorkspaceError>;
  readonly prepare: (
    input: PrepareThreadWorkspaceInput,
  ) => Effect.Effect<PreparedThreadWorkspace, ThreadWorkspaceError>;
  readonly delete: (
    workspace: ThreadWorkspace,
    options: { readonly force?: boolean },
  ) => Effect.Effect<void, ThreadWorkspaceError>;
}
