import type {
  SkillCatalogEntry,
  SkillId,
  SkillPack,
  SkillPackCatalog,
  SkillPackId,
  SkillPackProfile,
  ThreadSkillScope,
} from "@t3tools/contracts";

/**
 * Where the effective pack list came from. `core` is the untouched default
 * (no packs anywhere), `project` mirrors the project's default packs, and
 * `thread` is a selection that differs from the project default.
 */
export type SkillPackSelectionSource = "core" | "project" | "thread";

export interface SkillPackSelection {
  /** Effective pack ids in catalog order, unknown ids dropped. */
  readonly packIds: ReadonlyArray<SkillPackId>;
  readonly source: SkillPackSelectionSource;
  /** True when the effective packs equal the project default, including both empty. */
  readonly isProjectDefault: boolean;
  /** Only server threads report application state; drafts are always ready. */
  readonly state: ThreadSkillScope["state"];
  readonly issue: string | null;
  /** The profile whose packs exactly match the selection, if any. */
  readonly profile: SkillPackProfile | null;
}

function sameIdSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((id) => seen.has(id));
}

/** Keep catalog order, drop duplicates and ids the catalog does not know. */
export function normalizeSkillPackIds(
  catalog: Pick<SkillPackCatalog, "packs">,
  packIds: ReadonlyArray<SkillPackId>,
): ReadonlyArray<SkillPackId> {
  const wanted = new Set(packIds);
  return catalog.packs.filter((pack) => wanted.has(pack.id)).map((pack) => pack.id);
}

function matchSkillPackProfile(
  catalog: Pick<SkillPackCatalog, "profiles">,
  packIds: ReadonlyArray<SkillPackId>,
): SkillPackProfile | null {
  if (packIds.length === 0) return null;
  return catalog.profiles.find((profile) => sameIdSet(profile.packIds, packIds)) ?? null;
}

export function toggleSkillPackId(
  catalog: Pick<SkillPackCatalog, "packs">,
  packIds: ReadonlyArray<SkillPackId>,
  packId: SkillPackId,
): ReadonlyArray<SkillPackId> {
  const next = packIds.includes(packId)
    ? packIds.filter((id) => id !== packId)
    : [...packIds, packId];
  return normalizeSkillPackIds(catalog, next);
}

/**
 * Resolve what a surface shows for a thread or draft. A server thread reports
 * its scope (inherited packs included); a draft passes its picks, where `null`
 * or `undefined` means it follows the project default.
 */
export function resolveSkillPackSelection(input: {
  readonly catalog: SkillPackCatalog;
  readonly projectDefaultPackIds: ReadonlyArray<SkillPackId> | null | undefined;
  readonly threadScope?: ThreadSkillScope | null | undefined;
  readonly draftPackIds?: ReadonlyArray<SkillPackId> | null | undefined;
}): SkillPackSelection {
  const projectDefault = normalizeSkillPackIds(input.catalog, input.projectDefaultPackIds ?? []);
  const explicit = input.threadScope?.packIds ?? input.draftPackIds ?? null;
  const packIds =
    explicit === null ? projectDefault : normalizeSkillPackIds(input.catalog, explicit);
  const isProjectDefault = sameIdSet(packIds, projectDefault);
  return {
    packIds,
    source: !isProjectDefault ? "thread" : packIds.length === 0 ? "core" : "project",
    isProjectDefault,
    state: input.threadScope?.state ?? "ready",
    issue: input.threadScope?.issue ?? null,
    profile: matchSkillPackProfile(input.catalog, packIds),
  };
}

/** Short trigger text: "core", the matching profile, the single pack, or a count. */
export function formatSkillPackSelectionLabel(
  catalog: Pick<SkillPackCatalog, "packs">,
  selection: Pick<SkillPackSelection, "packIds" | "profile">,
): string {
  if (selection.profile) return selection.profile.displayName;
  if (selection.packIds.length === 0) return "core";
  if (selection.packIds.length === 1) {
    const pack = catalog.packs.find((candidate) => candidate.id === selection.packIds[0]);
    if (pack) return pack.displayName;
  }
  return `${selection.packIds.length} packs`;
}

/** Tooltip and accessible name for the composer trigger. */
export function formatSkillPackSelectionSummary(
  catalog: Pick<SkillPackCatalog, "packs">,
  selection: SkillPackSelection,
): string {
  const label = `Skills: ${formatSkillPackSelectionLabel(catalog, selection)}`;
  switch (selection.state) {
    case "pending":
      return `${label} · applies on the next turn`;
    case "degraded":
      return `${label} · ${selection.issue ?? "some skills could not be loaded"}`;
    case "ready":
      return label;
  }
}

export interface SkillPackSkillRow {
  readonly skill: SkillCatalogEntry;
  /**
   * Set when the skill is already active without this pack: it is core, or an
   * earlier selected pack lists it too. Such rows read as "already provided".
   */
  readonly providedBy: "core" | SkillPackId | null;
}

function catalogSkill(
  catalog: Pick<SkillPackCatalog, "skills">,
  skillId: SkillId,
): SkillCatalogEntry {
  return (
    catalog.skills.find((skill) => skill.id === skillId) ?? {
      id: skillId,
      displayName: skillId,
    }
  );
}

/**
 * The skills one pack contributes, annotated with prior providers. Core
 * always counts as provided; selected packs count in catalog order so a shared
 * skill is attributed to the first pack that lists it.
 */
export function describeSkillPackSkills(
  catalog: Pick<SkillPackCatalog, "skills" | "packs" | "coreSkillIds">,
  pack: SkillPack,
  selectedPackIds: ReadonlyArray<SkillPackId>,
): ReadonlyArray<SkillPackSkillRow> {
  const core = new Set(catalog.coreSkillIds);
  const packIndex = catalog.packs.findIndex((candidate) => candidate.id === pack.id);
  const earlierPacks = catalog.packs.filter(
    (candidate, index) => index < packIndex && selectedPackIds.includes(candidate.id),
  );
  return pack.skillIds.map((skillId) => ({
    skill: catalogSkill(catalog, skillId),
    providedBy: core.has(skillId)
      ? "core"
      : (earlierPacks.find((candidate) => candidate.skillIds.includes(skillId))?.id ?? null),
  }));
}

/** Every skill the selection activates, core first, without duplicates. */
export function resolveEffectiveSkills(
  catalog: SkillPackCatalog,
  packIds: ReadonlyArray<SkillPackId>,
): ReadonlyArray<SkillCatalogEntry> {
  const skillIds = new Set<SkillId>(catalog.coreSkillIds);
  for (const packId of normalizeSkillPackIds(catalog, packIds)) {
    const pack = catalog.packs.find((candidate) => candidate.id === packId);
    for (const skillId of pack?.skillIds ?? []) skillIds.add(skillId);
  }
  return [...skillIds].map((skillId) => catalogSkill(catalog, skillId));
}

/**
 * Pre-send note for providers that never load packs. The server reports the
 * remaining cases, such as an external OpenCode server, as a degraded scope.
 */
export function resolveSkillPackProviderWarning(input: {
  readonly driver: string | null | undefined;
  readonly packIds: ReadonlyArray<SkillPackId>;
}): string | null {
  if (input.packIds.length === 0 || !input.driver) return null;
  switch (input.driver) {
    case "codex":
    case "claudeAgent":
    case "opencode":
      return null;
    default:
      return "This provider cannot load skill packs. Its own skills still work; selected packs are ignored.";
  }
}
