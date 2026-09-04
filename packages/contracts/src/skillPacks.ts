import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

export const ThreadSkillScope = Schema.Struct({
  version: PositiveInt,
  appliedVersion: NonNegativeInt,
  packIds: Schema.Array(SkillPackId),
  state: Schema.Literals(["ready", "pending", "degraded"]),
  issue: Schema.optional(TrimmedNonEmptyString),
});
export type ThreadSkillScope = typeof ThreadSkillScope.Type;

/** Server-only materialized scope passed from orchestration to provider adapters. */
export const ProviderSkillScope = Schema.Struct({
  version: PositiveInt,
  packIds: Schema.Array(SkillPackId),
  skillIds: Schema.Array(SkillId),
  skillsPath: TrimmedNonEmptyString,
  pluginPath: TrimmedNonEmptyString,
});
export type ProviderSkillScope = typeof ProviderSkillScope.Type;
