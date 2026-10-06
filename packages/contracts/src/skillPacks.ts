import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SkillPackId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("SkillPackId"));
export type SkillPackId = typeof SkillPackId.Type;

export const SkillId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(96),
  Schema.isPattern(/^\.?[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("SkillId"));
export type SkillId = typeof SkillId.Type;

export const SkillCatalogEntry = Schema.Struct({
  id: SkillId,
  displayName: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  sourceUrl: Schema.optional(TrimmedNonEmptyString),
});
export type SkillCatalogEntry = typeof SkillCatalogEntry.Type;

export const SkillPack = Schema.Struct({
  id: SkillPackId,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  skillIds: Schema.Array(SkillId),
});
export type SkillPack = typeof SkillPack.Type;

export const SkillPackProfile = Schema.Struct({
  id: SkillPackId,
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  packIds: Schema.Array(SkillPackId),
});
export type SkillPackProfile = typeof SkillPackProfile.Type;

/** Public catalog metadata. Runtime paths stay on the server. */
export const SkillPackCatalog = Schema.Struct({
  version: Schema.Literal(1),
  coreSkillIds: Schema.Array(SkillId),
  skills: Schema.Array(SkillCatalogEntry),
  packs: Schema.Array(SkillPack),
  profiles: Schema.Array(SkillPackProfile),
});
export type SkillPackCatalog = typeof SkillPackCatalog.Type;

/**
 * A thread's effective packs. `pending` means the provider has not loaded this
 * selection yet; the next turn applies it. `degraded` carries the reason some
 * or all selected skills are missing from the provider.
 */
export const ThreadSkillScope = Schema.Struct({
  packIds: Schema.Array(SkillPackId),
  state: Schema.Literals(["ready", "pending", "degraded"]),
  issue: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadSkillScope = typeof ThreadSkillScope.Type;

export const SkillPackState = Schema.Struct({
  projectDefaultPackIds: Schema.Array(SkillPackId),
  /** Null when the subscription names no thread. */
  thread: Schema.NullOr(ThreadSkillScope),
});
export type SkillPackState = typeof SkillPackState.Type;

export const SkillPackSubscribeInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
});
export type SkillPackSubscribeInput = typeof SkillPackSubscribeInput.Type;

/** Also accepted before the thread exists, so a draft's packs apply to its first turn. */
export const SkillPackSetThreadInput = Schema.Struct({
  threadId: ThreadId,
  packIds: Schema.Array(SkillPackId),
});
export type SkillPackSetThreadInput = typeof SkillPackSetThreadInput.Type;

export const SkillPackSetProjectDefaultInput = Schema.Struct({
  projectId: ProjectId,
  packIds: Schema.Array(SkillPackId),
});
export type SkillPackSetProjectDefaultInput = typeof SkillPackSetProjectDefaultInput.Type;

export class SkillPackError extends Schema.TaggedError<SkillPackError>()("SkillPackError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const SKILL_PACK_WS_METHODS = {
  subscribe: "skillPacks.subscribe",
  setThreadPacks: "skillPacks.setThreadPacks",
  setProjectDefault: "skillPacks.setProjectDefault",
} as const;

/** Streams the project's default packs and, when named, one thread's scope. */
export const WsSkillPacksSubscribeRpc = Rpc.make(SKILL_PACK_WS_METHODS.subscribe, {
  payload: SkillPackSubscribeInput,
  success: SkillPackState,
  error: Schema.Union([SkillPackError, EnvironmentAuthorizationError]),
  stream: true,
});

export const WsSkillPacksSetThreadPacksRpc = Rpc.make(SKILL_PACK_WS_METHODS.setThreadPacks, {
  payload: SkillPackSetThreadInput,
  success: Schema.Void,
  error: Schema.Union([SkillPackError, EnvironmentAuthorizationError]),
});

export const WsSkillPacksSetProjectDefaultRpc = Rpc.make(SKILL_PACK_WS_METHODS.setProjectDefault, {
  payload: SkillPackSetProjectDefaultInput,
  success: Schema.Void,
  error: Schema.Union([SkillPackError, EnvironmentAuthorizationError]),
});
