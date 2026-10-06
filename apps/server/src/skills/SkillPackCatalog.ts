// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { type SkillPackCatalog, SkillId, SkillPackId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * The catalog the companion Nix infrastructure writes to
 * `T3CODE_SKILL_CATALOG_PATH`. Skill paths are canonical skill directories on
 * this host and never leave the server.
 */
const RuntimeSkill = Schema.Struct({
  id: SkillId,
  path: Schema.String,
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  sourceUrl: Schema.optional(Schema.String),
});
type RuntimeSkill = typeof RuntimeSkill.Type;

export const RuntimeSkillPackCatalog = Schema.Struct({
  version: Schema.Literal(1),
  coreSkillIds: Schema.Array(SkillId),
  skills: Schema.Array(RuntimeSkill),
  packs: Schema.Array(
    Schema.Struct({
      id: SkillPackId,
      displayName: Schema.String,
      description: Schema.String,
      skillIds: Schema.Array(SkillId),
    }),
  ),
  profiles: Schema.Array(
    Schema.Struct({
      id: SkillPackId,
      displayName: Schema.String,
      description: Schema.String,
      packIds: Schema.Array(SkillPackId),
    }),
  ),
});
export type RuntimeSkillPackCatalog = typeof RuntimeSkillPackCatalog.Type;

export const decodeRuntimeSkillPackCatalog = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RuntimeSkillPackCatalog),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function humanizeId(id: string): string {
  return id
    .replace(/^\./, "")
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function publicSkillPackCatalog(catalog: RuntimeSkillPackCatalog): SkillPackCatalog {
  return {
    version: 1,
    coreSkillIds: catalog.coreSkillIds,
    skills: catalog.skills.map((skill) => ({
      id: skill.id,
      displayName: skill.displayName?.trim() || humanizeId(skill.id),
      ...(skill.description?.trim() ? { description: skill.description.trim() } : {}),
      ...(skill.sourceUrl?.trim() ? { sourceUrl: skill.sourceUrl.trim() } : {}),
    })),
    packs: catalog.packs,
    profiles: catalog.profiles,
  };
}

export interface PackSkillSelection {
  /** Skills the packs add beyond core, in catalog order. Core skills load natively. */
  readonly skills: ReadonlyArray<RuntimeSkill>;
  /** Readable problems with the selection, empty when every skill resolved. */
  readonly problems: ReadonlyArray<string>;
}

export function selectPackSkills(
  catalog: RuntimeSkillPackCatalog,
  packIds: ReadonlyArray<SkillPackId>,
): PackSkillSelection {
  const requested = new Set(packIds);
  const packs = catalog.packs.filter((pack) => requested.has(pack.id));
  const unknownPackIds = [...requested].filter((id) => !packs.some((pack) => pack.id === id));
  const core = new Set(catalog.coreSkillIds);
  const wanted = new Set(packs.flatMap((pack) => pack.skillIds).filter((id) => !core.has(id)));
  const skills = catalog.skills.filter((skill) => wanted.has(skill.id));
  const missingSkillIds = [...wanted].filter((id) => !skills.some((skill) => skill.id === id));
  return {
    skills,
    problems: [
      ...(unknownPackIds.length > 0 ? [`Unknown packs: ${unknownPackIds.join(", ")}`] : []),
      ...(missingSkillIds.length > 0 ? [`Missing skills: ${missingSkillIds.join(", ")}`] : []),
    ],
  };
}

/** Every optional skill any pack offers. Codex loads these once and hides unselected ones. */
export function allPackSkills(catalog: RuntimeSkillPackCatalog): ReadonlyArray<RuntimeSkill> {
  return selectPackSkills(
    catalog,
    catalog.packs.map((pack) => pack.id),
  ).skills;
}

export interface MaterializedSkillRoot {
  /** Content digest; equal selections share one directory and one key. */
  readonly key: string;
  readonly skillIds: ReadonlyArray<SkillId>;
  /** `<root>/skills/<skill-id>` symlinks to the canonical skill directories. */
  readonly skillsPath: string;
  /** `<root>`, a Claude local plugin named `skills`. */
  readonly pluginPath: string;
}

/**
 * Link skills into `<stateDir>/skill-scopes/<digest>` without copying them.
 * Isolated project environments bind-mount `skill-scopes`, so the links must
 * live there.
 */
export const materializeSkillRoot = Effect.fn("SkillPackCatalog.materializeSkillRoot")(function* (
  stateDir: string,
  skills: ReadonlyArray<Pick<RuntimeSkill, "id" | "path">>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The plugin name is part of the digest so a rename gets a fresh directory.
  const key = NodeCrypto.createHash("sha256")
    .update(
      encodeJson({ pluginName: "skills", skills: skills.map((skill) => [skill.id, skill.path]) }),
    )
    .digest("hex")
    .slice(0, 24);
  const pluginPath = path.join(stateDir, "skill-scopes", key);
  const skillsPath = path.join(pluginPath, "skills");
  const manifestPath = path.join(pluginPath, ".claude-plugin", "plugin.json");

  yield* fileSystem.makeDirectory(skillsPath, { recursive: true });
  yield* fileSystem.makeDirectory(path.dirname(manifestPath), { recursive: true });
  yield* fileSystem.writeFileString(
    manifestPath,
    `${encodeJson({
      name: "skills",
      description: "Additional skills selected for this conversation.",
      version: "1.0.0",
    })}\n`,
  );
  yield* Effect.forEach(
    skills,
    (skill) => {
      const linkPath = path.join(skillsPath, skill.id);
      return fileSystem.readLink(linkPath).pipe(
        Effect.asVoid,
        Effect.catch(() => fileSystem.symlink(skill.path, linkPath)),
      );
    },
    { discard: true },
  );
  return { key, skillIds: skills.map((skill) => skill.id), skillsPath, pluginPath };
});
