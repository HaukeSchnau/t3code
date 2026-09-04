import type {
  ServerProvider,
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
 * `thread` is a per-thread override that differs from the project default.
 */
export type SkillPackSelectionSource = "core" | "project" | "thread";

export type SkillPackSelectionState = ThreadSkillScope["state"];

export interface SkillPackSelection {
  /** Effective pack ids in catalog order, unknown ids dropped. */
  readonly packIds: ReadonlyArray<SkillPackId>;
  readonly source: SkillPackSelectionSource;
  /** True when the effective packs equal the project default, including both empty. */
  readonly isProjectDefault: boolean;
  /** Only server threads report application state; drafts are always ready. */
  readonly state: SkillPackSelectionState;
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

export function matchSkillPackProfile(
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
 * Resolve what the composer should show for a thread or draft.
 *
 * A server thread carries its own scope once the server materialized it; a
 * missing scope (older threads) inherits the project default. Drafts pass
 * their pending pack list instead, where `null` also means inherit.
 */
export function resolveSkillPackSelection(input: {
  catalog: SkillPackCatalog;
  projectDefaultPackIds: ReadonlyArray<SkillPackId> | null | undefined;
  threadScope?: ThreadSkillScope | null | undefined;
  draftPackIds?: ReadonlyArray<SkillPackId> | null | undefined;
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
      return `${label} · ${selection.issue ?? "some skills could not be injected"}`;
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

function catalogSkill(catalog: Pick<SkillPackCatalog, "skills">, skillId: SkillId) {
  return (
    catalog.skills.find((skill) => skill.id === skillId) ?? {
      id: skillId,
      displayName: skillId,
    }
  );
}

/**
 * The skills one pack contributes, annotated with prior providers. The core
 * set always counts as provided; selected packs count in catalog order so a
 * shared skill is attributed to the first pack that lists it.
 */
export function describeSkillPackSkills(
  catalog: Pick<SkillPackCatalog, "skills" | "packs" | "coreSkillIds">,
  pack: SkillPack,
  selectedPackIds: ReadonlyArray<SkillPackId>,
): ReadonlyArray<SkillPackSkillRow> {
  const core = new Set(catalog.coreSkillIds);
  const earlierPacks = normalizeSkillPackIds(catalog, selectedPackIds)
    .filter((id) => id !== pack.id)
    .map((id) => catalog.packs.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is SkillPack => candidate !== undefined)
    .filter(
      (candidate) =>
        catalog.packs.findIndex((p) => p.id === candidate.id) <
        catalog.packs.findIndex((p) => p.id === pack.id),
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
  const seen = new Set<SkillId>();
  const result: SkillCatalogEntry[] = [];
  const add = (skillId: SkillId) => {
    if (seen.has(skillId)) return;
    seen.add(skillId);
    result.push(catalogSkill(catalog, skillId));
  };
  for (const skillId of catalog.coreSkillIds) add(skillId);
  for (const packId of normalizeSkillPackIds(catalog, packIds)) {
    const pack = catalog.packs.find((candidate) => candidate.id === packId);
    for (const skillId of pack?.skillIds ?? []) add(skillId);
  }
  return result;
}

/**
 * Whether the active provider can receive the selected packs. Provider-native
 * skills keep working regardless; only the pack injection is in question, so
 * a core-only selection never warns.
 */
export function resolveSkillPackProviderWarning(input: {
  provider: Pick<ServerProvider, "driver" | "skillScopeInjection"> | null | undefined;
  packIds: ReadonlyArray<SkillPackId>;
}): string | null {
  if (input.packIds.length === 0 || !input.provider) return null;
  const unsupported =
    input.provider.skillScopeInjection === "unsupported" ||
    (input.provider.skillScopeInjection === undefined && input.provider.driver === "opencode");
  return unsupported
    ? "This provider cannot load skill packs. Its own skills still work; selected packs are ignored."
    : null;
}
