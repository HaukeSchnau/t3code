import {
  GitChangeTurnLink,
  GitExternalTurnChange,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const VcsTurnScopeState = Schema.Literals(["running", "completed", "interrupted", "error"]);
export type VcsTurnScopeState = typeof VcsTurnScopeState.Type;

export const VcsTurnScope = Schema.Struct({
  repoRoot: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  vcs: Schema.Literals(["jj", "git"]),
  threadId: ThreadId,
  turnId: TurnId,
  state: VcsTurnScopeState,
  startOperationId: Schema.NullOr(TrimmedNonEmptyString),
  endOperationId: Schema.NullOr(TrimmedNonEmptyString),
  boundaryChangeId: Schema.NullOr(TrimmedNonEmptyString),
  fallbackChangeId: Schema.NullOr(TrimmedNonEmptyString),
  startedAt: TrimmedNonEmptyString,
  completedAt: Schema.NullOr(TrimmedNonEmptyString),
  lastReconciledAt: Schema.NullOr(TrimmedNonEmptyString),
});
export type VcsTurnScope = typeof VcsTurnScope.Type;

export const VcsTurnChangeLink = Schema.Struct({
  repoRoot: TrimmedNonEmptyString,
  changeId: TrimmedNonEmptyString,
  threadId: ThreadId,
  turnId: TurnId,
  role: GitChangeTurnLink.fields.role,
  firstOperationId: Schema.NullOr(TrimmedNonEmptyString),
  lastOperationId: Schema.NullOr(TrimmedNonEmptyString),
  firstCommitId: Schema.NullOr(TrimmedNonEmptyString),
  latestCommitId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  prunedAt: Schema.NullOr(TrimmedNonEmptyString),
});
export type VcsTurnChangeLink = typeof VcsTurnChangeLink.Type;

export const VcsExternalTurnDiff = Schema.Struct({
  ...GitExternalTurnChange.fields,
  createdAt: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
});
export type VcsExternalTurnDiff = typeof VcsExternalTurnDiff.Type;

export interface VcsTurnChangeRepositoryShape {
  readonly upsertScope: (scope: VcsTurnScope) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly completeScope: (input: {
    readonly repoRoot: string;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly state: VcsTurnScopeState;
    readonly endOperationId: string | null;
    readonly fallbackChangeId: string | null;
    readonly completedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getScope: (input: {
    readonly repoRoot: string;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
  }) => Effect.Effect<VcsTurnScope | null, ProjectionRepositoryError>;
  readonly listScopesByThread: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<ReadonlyArray<VcsTurnScope>, ProjectionRepositoryError>;
  readonly upsertLink: (link: VcsTurnChangeLink) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listLinksByChangeIds: (input: {
    readonly repoRoot: string;
    readonly changeIds: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<VcsTurnChangeLink>, ProjectionRepositoryError>;
  readonly listLinksByThread: (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
  }) => Effect.Effect<ReadonlyArray<VcsTurnChangeLink>, ProjectionRepositoryError>;
  readonly markPruned: (input: {
    readonly repoRoot: string;
    readonly changeIds: ReadonlyArray<string>;
    readonly prunedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class VcsTurnChangeRepository extends Context.Service<
  VcsTurnChangeRepository,
  VcsTurnChangeRepositoryShape
>()("t3/persistence/Services/VcsTurnChanges/VcsTurnChangeRepository") {}

export interface VcsExternalDiffRepositoryShape {
  readonly upsert: (diff: VcsExternalTurnDiff) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThread: (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
  }) => Effect.Effect<ReadonlyArray<VcsExternalTurnDiff>, ProjectionRepositoryError>;
}

export class VcsExternalDiffRepository extends Context.Service<
  VcsExternalDiffRepository,
  VcsExternalDiffRepositoryShape
>()("t3/persistence/Services/VcsTurnChanges/VcsExternalDiffRepository") {}
