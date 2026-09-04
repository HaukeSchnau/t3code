// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  type ProviderSkillScope,
  type SkillPackCatalog,
  SkillPackId,
  SkillId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";

const RuntimeSkill = Schema.Struct({
  id: SkillId,
  path: Schema.String,
  displayName: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  sourceUrl: Schema.optional(Schema.String),
});

const RuntimePack = Schema.Struct({
  id: SkillPackId,
  displayName: Schema.String,
  description: Schema.String,
  skillIds: Schema.Array(SkillId),
});

const RuntimeProfile = Schema.Struct({
  id: SkillPackId,
  displayName: Schema.String,
  description: Schema.String,
  packIds: Schema.Array(SkillPackId),
});

export const RuntimeSkillPackCatalog = Schema.Struct({
  version: Schema.Literal(1),
  coreSkillIds: Schema.Array(SkillId),
  skills: Schema.Array(RuntimeSkill),
  packs: Schema.Array(RuntimePack),
  profiles: Schema.Array(RuntimeProfile),
});
export type RuntimeSkillPackCatalog = typeof RuntimeSkillPackCatalog.Type;

const decodeRuntimeCatalog = Schema.decodeUnknownEffect(
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

export const loadSkillPackCatalog = Effect.fn("SkillPackRuntime.loadCatalog")(function* (options?: {
  readonly catalogPath?: string;
}) {
  const catalogPath = options?.catalogPath ?? process.env.T3CODE_SKILL_CATALOG_PATH?.trim();
  if (!catalogPath) return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(catalogPath);
  return yield* decodeRuntimeCatalog(raw);
});

function selectedSkills(catalog: RuntimeSkillPackCatalog, packIds: ReadonlyArray<SkillPackId>) {
  const requested = new Set(packIds);
  const knownPacks = catalog.packs.filter((pack) => requested.has(pack.id));
  const knownPackIds = new Set(knownPacks.map((pack) => pack.id));
  const missingPackIds = [...requested].filter((id) => !knownPackIds.has(id));
  const requestedSkillIds = new Set(knownPacks.flatMap((pack) => pack.skillIds));
  const skills = catalog.skills.filter((skill) => requestedSkillIds.has(skill.id));
  const resolvedIds = new Set(skills.map((skill) => skill.id));
  const missingSkillIds = [...requestedSkillIds].filter((id) => !resolvedIds.has(id));
  return { skills, missingPackIds, missingSkillIds };
}

export interface MaterializedSkillScope {
  readonly scope: ProviderSkillScope | undefined;
  readonly issue: string | undefined;
}

export const materializeSkillScope = Effect.fn("SkillPackRuntime.materializeScope")(
  function* (input: {
    readonly catalog: RuntimeSkillPackCatalog | null;
    readonly packIds: ReadonlyArray<SkillPackId>;
    readonly version: ProviderSkillScope["version"];
  }) {
    if (input.packIds.length === 0) return { scope: undefined, issue: undefined };
    if (input.catalog === null) {
      return {
        scope: undefined,
        issue: "This environment has no skill pack catalog.",
      };
    }

    const { skills, missingPackIds, missingSkillIds } = selectedSkills(
      input.catalog,
      input.packIds,
    );
    const problems = [
      ...(missingPackIds.length > 0 ? [`Unknown packs: ${missingPackIds.join(", ")}`] : []),
      ...(missingSkillIds.length > 0 ? [`Missing skills: ${missingSkillIds.join(", ")}`] : []),
    ];
    if (skills.length === 0) {
      return {
        scope: undefined,
        issue: problems.join(". ") || "The selected packs contain no available skills.",
      };
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const digest = NodeCrypto.createHash("sha256")
      .update(
        encodeJson({
          version: input.catalog.version,
          packs: [...input.packIds].sort(),
          skills: skills.map((skill) => [skill.id, skill.path]).sort(),
        }),
      )
      .digest("hex")
      .slice(0, 24);
    const scopeRoot = path.join(serverConfig.stateDir, "skill-scopes", digest);
    const skillsPath = path.join(scopeRoot, "skills");
    const pluginManifestPath = path.join(scopeRoot, ".claude-plugin", "plugin.json");

    yield* fileSystem.makeDirectory(skillsPath, { recursive: true });
    yield* fileSystem.makeDirectory(path.dirname(pluginManifestPath), { recursive: true });
    yield* fileSystem.writeFileString(
      pluginManifestPath,
      `${encodeJson({
        name: `t3-skill-scope-${digest}`,
        description: "Additional skills selected for this T3 Code thread.",
        version: "1.0.0",
      })}\n`,
    );
    yield* Effect.forEach(
      skills,
      (skill) => {
        const linkPath = path.join(skillsPath, skill.id);
        return fileSystem
          .exists(linkPath)
          .pipe(
            Effect.flatMap((exists) =>
              exists ? Effect.void : fileSystem.symlink(skill.path, linkPath),
            ),
          );
      },
      { concurrency: 1 },
    );

    return {
      scope: {
        version: input.version,
        packIds: [...input.packIds],
        skillIds: skills.map((skill) => skill.id),
        skillsPath,
        pluginPath: scopeRoot,
      },
      issue: problems.length > 0 ? problems.join(". ") : undefined,
    };
  },
);
