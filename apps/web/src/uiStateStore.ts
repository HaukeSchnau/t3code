import { Debouncer } from "@tanstack/react-pacer";
import { create } from "zustand";
import { sanitizeTagColor, tagColorFromId, type UiTagColor } from "./tagColors";

export const PERSISTED_STATE_KEY = "t3code:ui-state:v1";
const LEGACY_PERSISTED_STATE_KEYS = [
  "t3code:renderer-state:v8",
  "t3code:renderer-state:v7",
  "t3code:renderer-state:v6",
  "t3code:renderer-state:v5",
  "t3code:renderer-state:v4",
  "t3code:renderer-state:v3",
  "codething:renderer-state:v4",
  "codething:renderer-state:v3",
  "codething:renderer-state:v2",
  "codething:renderer-state:v1",
] as const;
const TAG_COMBINATION_GROUP_ID_PREFIX = "tag-combination:";

export interface PersistedUiState {
  collapsedProjectCwds?: string[];
  expandedProjectCwds?: string[];
  projectOrderCwds?: string[];
  defaultAdvertisedEndpointKey?: string | null;
  sidebarViewMode?: SidebarViewMode;
  threadPinnedAtById?: Record<string, string>;
  tagById?: Record<string, UiTag>;
  threadTagIdsByThreadKey?: Record<string, string[]>;
  projectTagIdsByProjectKey?: Record<string, string[]>;
  tagExpandedById?: Record<string, boolean>;
}

export interface UiProjectState {
  projectExpandedById: Record<string, boolean>;
  projectOrder: string[];
}

export interface UiThreadState {
  threadLastVisitedAtById: Record<string, string>;
  threadPinnedAtById: Record<string, string>;
}

export interface UiEndpointState {
  defaultAdvertisedEndpointKey: string | null;
}

export type SidebarViewMode = "projects" | "all-threads" | "tags";

export interface UiSidebarState {
  sidebarViewMode: SidebarViewMode;
}

export interface UiTag {
  id: string;
  name: string;
  color: UiTagColor;
  createdAt: string;
}

export interface UiTagState {
  tagById: Record<string, UiTag>;
  threadTagIdsByThreadKey: Record<string, string[]>;
  projectTagIdsByProjectKey: Record<string, string[]>;
  tagExpandedById: Record<string, boolean>;
}

export interface UiState
  extends UiProjectState, UiThreadState, UiEndpointState, UiSidebarState, UiTagState {}

export interface SyncProjectInput {
  /** Physical project key (env + cwd). Used for manual sort order. */
  key: string;
  /** Logical group key. Used for expand/collapse state. */
  logicalKey: string;
  cwd: string;
}

export interface SyncThreadInput {
  key: string;
  seedVisitedAt?: string | undefined;
}

const initialState: UiState = {
  projectExpandedById: {},
  projectOrder: [],
  threadLastVisitedAtById: {},
  threadPinnedAtById: {},
  defaultAdvertisedEndpointKey: null,
  sidebarViewMode: "projects",
  tagById: {},
  threadTagIdsByThreadKey: {},
  projectTagIdsByProjectKey: {},
  tagExpandedById: {},
};

const persistedCollapsedProjectCwds = new Set<string>();
const persistedExpandedProjectCwds = new Set<string>();
const persistedProjectOrderCwds: string[] = [];
const persistedProjectOrderCwdSet = new Set<string>();
// Pre-fix persisted shape only listed expanded cwds, so anything not listed
// was treated as collapsed. Track whether the loaded blob carried the new
// `collapsedProjectCwds` field so we can preserve that legacy semantic for
// one session after upgrade, until persistState rewrites in the new shape.
let persistedProjectStateUsesLegacyShape = false;
const currentProjectCwdById = new Map<string, string>();
const currentProjectCwdsByLogicalKey = new Map<string, string[]>();
const currentLogicalKeyByPhysicalKey = new Map<string, string>();
let legacyKeysCleanedUp = false;

function readPersistedState(): UiState {
  if (typeof window === "undefined") {
    return initialState;
  }
  try {
    const raw = window.localStorage.getItem(PERSISTED_STATE_KEY);
    if (!raw) {
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        const legacyRaw = window.localStorage.getItem(legacyKey);
        if (!legacyRaw) {
          continue;
        }
        hydratePersistedProjectState(JSON.parse(legacyRaw) as PersistedUiState);
        return initialState;
      }
      return initialState;
    }
    const parsed = JSON.parse(raw) as PersistedUiState;
    hydratePersistedProjectState(parsed);
    return {
      ...initialState,
      defaultAdvertisedEndpointKey:
        typeof parsed.defaultAdvertisedEndpointKey === "string" &&
        parsed.defaultAdvertisedEndpointKey.length > 0
          ? parsed.defaultAdvertisedEndpointKey
          : null,
      sidebarViewMode: sanitizeSidebarViewMode(parsed.sidebarViewMode),
      threadPinnedAtById: sanitizePersistedIsoRecord(parsed.threadPinnedAtById),
      tagById: sanitizePersistedTagCatalog(parsed.tagById),
      threadTagIdsByThreadKey: sanitizePersistedTagReferenceRecord(parsed.threadTagIdsByThreadKey),
      projectTagIdsByProjectKey: sanitizePersistedTagReferenceRecord(
        parsed.projectTagIdsByProjectKey,
      ),
      tagExpandedById: sanitizePersistedBooleanRecord(parsed.tagExpandedById),
    };
  } catch {
    return initialState;
  }
}

function sanitizeSidebarViewMode(value: PersistedUiState["sidebarViewMode"]): SidebarViewMode {
  return value === "all-threads" || value === "tags" ? value : "projects";
}

export function normalizeTagName(value: string): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

export function tagIdFromName(name: string): string {
  return name.toLocaleLowerCase();
}

function sanitizeTagId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sanitizePersistedTagCatalog(value: unknown): Record<string, UiTag> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextTags: Record<string, UiTag> = {};
  for (const [key, tag] of Object.entries(value)) {
    if (!tag || typeof tag !== "object") {
      continue;
    }
    const persistedTag = tag as Partial<UiTag>;
    const id = sanitizeTagId(persistedTag.id) ?? sanitizeTagId(key);
    const name = normalizeTagName(typeof persistedTag.name === "string" ? persistedTag.name : "");
    const createdAt =
      typeof persistedTag.createdAt === "string" &&
      Number.isFinite(Date.parse(persistedTag.createdAt))
        ? persistedTag.createdAt
        : new Date(0).toISOString();
    if (!id || !name) {
      continue;
    }
    nextTags[id] = {
      id,
      name,
      color: sanitizeTagColor(persistedTag.color) ?? tagColorFromId(id),
      createdAt,
    };
  }
  return nextTags;
}

function sanitizePersistedTagReferenceRecord(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const nextRecord: Record<string, string[]> = {};
  for (const [key, tagIds] of Object.entries(value)) {
    if (!key || !Array.isArray(tagIds)) {
      continue;
    }
    const seen = new Set<string>();
    const nextTagIds: string[] = [];
    for (const rawTagId of tagIds) {
      const tagId = sanitizeTagId(rawTagId);
      if (!tagId || seen.has(tagId)) {
        continue;
      }
      seen.add(tagId);
      nextTagIds.push(tagId);
    }
    if (nextTagIds.length > 0) {
      nextRecord[key] = nextTagIds;
    }
  }
  return nextRecord;
}

function sanitizePersistedBooleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, expanded]) => key.length > 0 && typeof expanded === "boolean",
    ),
  );
}

function sanitizePersistedIsoRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, iso]) =>
        key.length > 0 &&
        typeof iso === "string" &&
        iso.length > 0 &&
        Number.isFinite(Date.parse(iso)),
    ),
  );
}

export function hydratePersistedProjectState(parsed: PersistedUiState): void {
  persistedCollapsedProjectCwds.clear();
  persistedExpandedProjectCwds.clear();
  persistedProjectOrderCwds.length = 0;
  persistedProjectOrderCwdSet.clear();
  persistedProjectStateUsesLegacyShape = !Array.isArray(parsed.collapsedProjectCwds);
  for (const cwd of parsed.collapsedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedCollapsedProjectCwds.add(cwd);
    }
  }
  for (const cwd of parsed.expandedProjectCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0) {
      persistedExpandedProjectCwds.add(cwd);
    }
  }
  for (const cwd of parsed.projectOrderCwds ?? []) {
    if (typeof cwd === "string" && cwd.length > 0 && !persistedProjectOrderCwdSet.has(cwd)) {
      persistedProjectOrderCwdSet.add(cwd);
      persistedProjectOrderCwds.push(cwd);
    }
  }
}

export function persistState(state: UiState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    // Persist collapsed cwds explicitly so an empty/missing field unambiguously
    // means "first install" rather than "user collapsed everything"; without
    // this, the syncProjects fallback would re-expand all rows on next launch.
    const collapsedProjectCwds = Object.entries(state.projectExpandedById)
      .filter(([, expanded]) => !expanded)
      .flatMap(([logicalKey]) => currentProjectCwdsByLogicalKey.get(logicalKey) ?? []);
    const expandedProjectCwds = Object.entries(state.projectExpandedById)
      .filter(([, expanded]) => expanded)
      .flatMap(([logicalKey]) => currentProjectCwdsByLogicalKey.get(logicalKey) ?? []);
    const projectOrderCwds = state.projectOrder.flatMap((projectId) => {
      const cwd = currentProjectCwdById.get(projectId);
      return cwd ? [cwd] : [];
    });
    window.localStorage.setItem(
      PERSISTED_STATE_KEY,
      JSON.stringify({
        collapsedProjectCwds,
        expandedProjectCwds,
        projectOrderCwds,
        defaultAdvertisedEndpointKey: state.defaultAdvertisedEndpointKey,
        sidebarViewMode: state.sidebarViewMode,
        threadPinnedAtById: state.threadPinnedAtById,
        tagById: state.tagById,
        threadTagIdsByThreadKey: state.threadTagIdsByThreadKey,
        projectTagIdsByProjectKey: state.projectTagIdsByProjectKey,
        tagExpandedById: state.tagExpandedById,
      } satisfies PersistedUiState),
    );
    if (!legacyKeysCleanedUp) {
      legacyKeysCleanedUp = true;
      for (const legacyKey of LEGACY_PERSISTED_STATE_KEYS) {
        window.localStorage.removeItem(legacyKey);
      }
    }
  } catch {
    // Ignore quota/storage errors to avoid breaking chat UX.
  }
}

const debouncedPersistState = new Debouncer(persistState, { wait: 500 });

function recordsEqual<T>(left: Record<string, T>, right: Record<string, T>): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    if (right[key] !== value) {
      return false;
    }
  }
  return true;
}

function stringArrayRecordsEqual(
  left: Record<string, string[]>,
  right: Record<string, string[]>,
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, leftValues] of leftEntries) {
    const rightValues = right[key];
    if (
      !rightValues ||
      leftValues.length !== rightValues.length ||
      leftValues.some((value, index) => value !== rightValues[index])
    ) {
      return false;
    }
  }
  return true;
}

function pruneUnknownTagExpansion(state: UiState): UiState {
  const nextTagExpandedById = Object.fromEntries(
    Object.entries(state.tagExpandedById).filter(
      ([tagId]) => state.tagById[tagId] || tagId.startsWith(TAG_COMBINATION_GROUP_ID_PREFIX),
    ),
  );

  if (recordsEqual(state.tagExpandedById, nextTagExpandedById)) {
    return state;
  }

  return {
    ...state,
    tagExpandedById: nextTagExpandedById,
  };
}

function projectOrdersEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((projectId, index) => projectId === right[index])
  );
}

export function syncProjects(state: UiState, projects: readonly SyncProjectInput[]): UiState {
  const previousProjectCwdById = new Map(currentProjectCwdById);
  const previousLogicalKeyByPhysicalKey = new Map(currentLogicalKeyByPhysicalKey);
  currentProjectCwdById.clear();
  currentLogicalKeyByPhysicalKey.clear();
  for (const project of projects) {
    currentProjectCwdById.set(project.key, project.cwd);
    currentLogicalKeyByPhysicalKey.set(project.key, project.logicalKey);
  }
  currentProjectCwdsByLogicalKey.clear();
  const currentProjectCwdSetsByLogicalKey = new Map<string, Set<string>>();
  for (const project of projects) {
    const cwds = currentProjectCwdsByLogicalKey.get(project.logicalKey);
    if (cwds) {
      let cwdSet = currentProjectCwdSetsByLogicalKey.get(project.logicalKey);
      if (!cwdSet) {
        cwdSet = new Set(cwds);
        currentProjectCwdSetsByLogicalKey.set(project.logicalKey, cwdSet);
      }
      if (!cwdSet.has(project.cwd)) {
        cwdSet.add(project.cwd);
        cwds.push(project.cwd);
      }
    } else {
      currentProjectCwdsByLogicalKey.set(project.logicalKey, [project.cwd]);
      currentProjectCwdSetsByLogicalKey.set(project.logicalKey, new Set([project.cwd]));
    }
  }
  // Build reverse map: for each new logical key, which previous logical keys
  // did its member projects live under? Lets us preserve expand state when a
  // project's logical key changes (e.g. late-arriving repo metadata flips the
  // group identity).
  const previousLogicalKeysByNewLogicalKey = new Map<string, Set<string>>();
  for (const project of projects) {
    const previousLogicalKey = previousLogicalKeyByPhysicalKey.get(project.key);
    if (!previousLogicalKey || previousLogicalKey === project.logicalKey) {
      continue;
    }
    const set = previousLogicalKeysByNewLogicalKey.get(project.logicalKey);
    if (set) {
      set.add(previousLogicalKey);
    } else {
      previousLogicalKeysByNewLogicalKey.set(project.logicalKey, new Set([previousLogicalKey]));
    }
  }
  const cwdMappingChanged =
    previousProjectCwdById.size !== currentProjectCwdById.size ||
    projects.some((project) => previousProjectCwdById.get(project.key) !== project.cwd);

  const nextExpandedById: Record<string, boolean> = {};
  const previousExpandedById = state.projectExpandedById;
  const persistedOrderByCwd = new Map(
    persistedProjectOrderCwds.map((cwd, index) => [cwd, index] as const),
  );
  const mappedProjects = projects.map((project, index) => {
    if (!(project.logicalKey in nextExpandedById)) {
      const groupCwds = currentProjectCwdsByLogicalKey.get(project.logicalKey) ?? [project.cwd];
      const fallbackFromPreviousLogicalKey = (() => {
        const previousKeys = previousLogicalKeysByNewLogicalKey.get(project.logicalKey);
        if (!previousKeys) {
          return undefined;
        }
        for (const previousKey of previousKeys) {
          if (previousKey in previousExpandedById) {
            return previousExpandedById[previousKey];
          }
        }
        return undefined;
      })();
      const fallbackFromPersistedShape = (() => {
        if (groupCwds.some((cwd) => persistedExpandedProjectCwds.has(cwd))) {
          return true;
        }
        if (groupCwds.some((cwd) => persistedCollapsedProjectCwds.has(cwd))) {
          return false;
        }
        if (persistedProjectStateUsesLegacyShape && persistedExpandedProjectCwds.size > 0) {
          return false;
        }
        return true;
      })();
      const expanded =
        previousExpandedById[project.logicalKey] ??
        fallbackFromPreviousLogicalKey ??
        fallbackFromPersistedShape;
      nextExpandedById[project.logicalKey] = expanded;
    }
    return {
      id: project.key,
      cwd: project.cwd,
      incomingIndex: index,
    };
  });

  const nextProjectOrder =
    state.projectOrder.length > 0
      ? (() => {
          const currentProjectIds = new Set(mappedProjects.map((project) => project.id));
          const nextProjectIdByCwd = new Map(
            mappedProjects.map((project) => [project.cwd, project.id] as const),
          );
          const usedProjectIds = new Set<string>();
          const orderedProjectIds: string[] = [];

          for (const projectId of state.projectOrder) {
            const matchedProjectId =
              (currentProjectIds.has(projectId) ? projectId : undefined) ??
              (() => {
                const previousCwd = previousProjectCwdById.get(projectId);
                return previousCwd ? nextProjectIdByCwd.get(previousCwd) : undefined;
              })();
            if (!matchedProjectId || usedProjectIds.has(matchedProjectId)) {
              continue;
            }
            usedProjectIds.add(matchedProjectId);
            orderedProjectIds.push(matchedProjectId);
          }

          for (const project of mappedProjects) {
            if (usedProjectIds.has(project.id)) {
              continue;
            }
            orderedProjectIds.push(project.id);
          }

          return orderedProjectIds;
        })()
      : mappedProjects
          .map((project) => ({
            id: project.id,
            incomingIndex: project.incomingIndex,
            orderIndex:
              persistedOrderByCwd.get(project.cwd) ??
              persistedProjectOrderCwds.length + project.incomingIndex,
          }))
          .toSorted((left, right) => {
            const byOrder = left.orderIndex - right.orderIndex;
            if (byOrder !== 0) {
              return byOrder;
            }
            return left.incomingIndex - right.incomingIndex;
          })
          .map((project) => project.id);

  const currentProjectKeys = new Set(projects.map((project) => project.key));
  const nextProjectTagIdsByProjectKey = Object.fromEntries(
    Object.entries(state.projectTagIdsByProjectKey).filter(([projectKey]) =>
      currentProjectKeys.has(projectKey),
    ),
  );

  if (
    recordsEqual(state.projectExpandedById, nextExpandedById) &&
    projectOrdersEqual(state.projectOrder, nextProjectOrder) &&
    stringArrayRecordsEqual(state.projectTagIdsByProjectKey, nextProjectTagIdsByProjectKey) &&
    !cwdMappingChanged
  ) {
    return state;
  }

  return pruneUnknownTagExpansion({
    ...state,
    projectExpandedById: nextExpandedById,
    projectOrder: nextProjectOrder,
    projectTagIdsByProjectKey: nextProjectTagIdsByProjectKey,
  });
}

export function syncThreads(state: UiState, threads: readonly SyncThreadInput[]): UiState {
  const retainedThreadIds = new Set(threads.map((thread) => thread.key));
  const nextThreadLastVisitedAtById = Object.fromEntries(
    Object.entries(state.threadLastVisitedAtById).filter(([threadId]) =>
      retainedThreadIds.has(threadId),
    ),
  );
  for (const thread of threads) {
    if (
      nextThreadLastVisitedAtById[thread.key] === undefined &&
      thread.seedVisitedAt !== undefined &&
      thread.seedVisitedAt.length > 0
    ) {
      nextThreadLastVisitedAtById[thread.key] = thread.seedVisitedAt;
    }
  }
  const nextThreadPinnedAtById = Object.fromEntries(
    Object.entries(state.threadPinnedAtById).filter(([threadId]) =>
      retainedThreadIds.has(threadId),
    ),
  );
  const nextThreadTagIdsByThreadKey = Object.fromEntries(
    Object.entries(state.threadTagIdsByThreadKey).filter(([threadId]) =>
      retainedThreadIds.has(threadId),
    ),
  );
  if (
    recordsEqual(state.threadLastVisitedAtById, nextThreadLastVisitedAtById) &&
    recordsEqual(state.threadPinnedAtById, nextThreadPinnedAtById) &&
    stringArrayRecordsEqual(state.threadTagIdsByThreadKey, nextThreadTagIdsByThreadKey)
  ) {
    return state;
  }
  return pruneUnknownTagExpansion({
    ...state,
    threadLastVisitedAtById: nextThreadLastVisitedAtById,
    threadPinnedAtById: nextThreadPinnedAtById,
    threadTagIdsByThreadKey: nextThreadTagIdsByThreadKey,
  });
}

export function setSidebarViewMode(state: UiState, mode: SidebarViewMode): UiState {
  if (state.sidebarViewMode === mode) {
    return state;
  }
  return {
    ...state,
    sidebarViewMode: mode,
  };
}

export function markThreadVisited(state: UiState, threadId: string, visitedAt?: string): UiState {
  const at = visitedAt ?? new Date().toISOString();
  const visitedAtMs = Date.parse(at);
  const previousVisitedAt = state.threadLastVisitedAtById[threadId];
  const previousVisitedAtMs = previousVisitedAt ? Date.parse(previousVisitedAt) : NaN;
  if (
    Number.isFinite(previousVisitedAtMs) &&
    Number.isFinite(visitedAtMs) &&
    previousVisitedAtMs >= visitedAtMs
  ) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: at,
    },
  };
}

export function markThreadUnread(
  state: UiState,
  threadId: string,
  latestTurnCompletedAt: string | null | undefined,
): UiState {
  if (!latestTurnCompletedAt) {
    return state;
  }
  const latestTurnCompletedAtMs = Date.parse(latestTurnCompletedAt);
  if (Number.isNaN(latestTurnCompletedAtMs)) {
    return state;
  }
  const unreadVisitedAt = new Date(latestTurnCompletedAtMs - 1).toISOString();
  if (state.threadLastVisitedAtById[threadId] === unreadVisitedAt) {
    return state;
  }
  return {
    ...state,
    threadLastVisitedAtById: {
      ...state.threadLastVisitedAtById,
      [threadId]: unreadVisitedAt,
    },
  };
}

export function clearThreadUi(state: UiState, threadId: string): UiState {
  const hasVisitedState = threadId in state.threadLastVisitedAtById;
  const hasPinnedState = threadId in state.threadPinnedAtById;
  const hasTagState = threadId in state.threadTagIdsByThreadKey;
  if (!hasVisitedState && !hasPinnedState && !hasTagState) {
    return state;
  }
  const nextThreadLastVisitedAtById = { ...state.threadLastVisitedAtById };
  const nextThreadPinnedAtById = { ...state.threadPinnedAtById };
  const nextThreadTagIdsByThreadKey = { ...state.threadTagIdsByThreadKey };
  delete nextThreadLastVisitedAtById[threadId];
  delete nextThreadPinnedAtById[threadId];
  delete nextThreadTagIdsByThreadKey[threadId];
  return {
    ...state,
    threadLastVisitedAtById: nextThreadLastVisitedAtById,
    threadPinnedAtById: nextThreadPinnedAtById,
    threadTagIdsByThreadKey: nextThreadTagIdsByThreadKey,
  };
}

export function setThreadPinned(
  state: UiState,
  threadId: string,
  pinned: boolean,
  pinnedAt?: string,
): UiState {
  const isCurrentlyPinned = threadId in state.threadPinnedAtById;
  if (pinned === isCurrentlyPinned) {
    return state;
  }

  if (!pinned) {
    const nextThreadPinnedAtById = { ...state.threadPinnedAtById };
    delete nextThreadPinnedAtById[threadId];
    return {
      ...state,
      threadPinnedAtById: nextThreadPinnedAtById,
    };
  }

  return {
    ...state,
    threadPinnedAtById: {
      ...state.threadPinnedAtById,
      [threadId]: pinnedAt ?? new Date().toISOString(),
    },
  };
}

function addTagReference(
  state: UiState,
  recordKey: string,
  tagName: string,
  recordName: "threadTagIdsByThreadKey" | "projectTagIdsByProjectKey",
  createdAt?: string,
): UiState {
  const normalizedName = normalizeTagName(tagName);
  if (!normalizedName) {
    return state;
  }
  const tagId = tagIdFromName(normalizedName);
  const currentTagIds = state[recordName][recordKey] ?? [];
  const existingTag = state.tagById[tagId];
  if (existingTag && currentTagIds.includes(tagId)) {
    return state;
  }

  return {
    ...state,
    tagById: existingTag
      ? state.tagById
      : {
          ...state.tagById,
          [tagId]: {
            id: tagId,
            name: normalizedName,
            color: tagColorFromId(tagId),
            createdAt: createdAt ?? new Date().toISOString(),
          },
        },
    tagExpandedById:
      tagId in state.tagExpandedById
        ? state.tagExpandedById
        : {
            ...state.tagExpandedById,
            [tagId]: true,
          },
    [recordName]: {
      ...state[recordName],
      [recordKey]: currentTagIds.includes(tagId) ? currentTagIds : [...currentTagIds, tagId],
    },
  };
}

function removeTagReference(
  state: UiState,
  recordKey: string,
  tagId: string,
  recordName: "threadTagIdsByThreadKey" | "projectTagIdsByProjectKey",
): UiState {
  const currentTagIds = state[recordName][recordKey] ?? [];
  if (!currentTagIds.includes(tagId)) {
    return state;
  }

  const nextTagIds = currentTagIds.filter((currentTagId) => currentTagId !== tagId);
  const nextRecord = { ...state[recordName] };
  if (nextTagIds.length > 0) {
    nextRecord[recordKey] = nextTagIds;
  } else {
    delete nextRecord[recordKey];
  }

  return {
    ...state,
    [recordName]: nextRecord,
  };
}

export function addTagToThread(
  state: UiState,
  threadKey: string,
  tagName: string,
  createdAt?: string,
): UiState {
  return addTagReference(state, threadKey, tagName, "threadTagIdsByThreadKey", createdAt);
}

export function removeTagFromThread(state: UiState, threadKey: string, tagId: string): UiState {
  return removeTagReference(state, threadKey, tagId, "threadTagIdsByThreadKey");
}

export function addTagToProject(
  state: UiState,
  projectKey: string,
  tagName: string,
  createdAt?: string,
): UiState {
  return addTagReference(state, projectKey, tagName, "projectTagIdsByProjectKey", createdAt);
}

export function removeTagFromProject(state: UiState, projectKey: string, tagId: string): UiState {
  return removeTagReference(state, projectKey, tagId, "projectTagIdsByProjectKey");
}

function replaceTagIdReferences(record: Record<string, string[]>, fromId: string, toId: string) {
  const nextRecord: Record<string, string[]> = {};
  let changed = false;
  for (const [recordKey, tagIds] of Object.entries(record)) {
    const seen = new Set<string>();
    const nextTagIds: string[] = [];
    for (const tagId of tagIds) {
      const nextTagId = tagId === fromId ? toId : tagId;
      if (nextTagId !== tagId) {
        changed = true;
      }
      if (seen.has(nextTagId)) {
        changed = true;
        continue;
      }
      seen.add(nextTagId);
      nextTagIds.push(nextTagId);
    }
    nextRecord[recordKey] = nextTagIds;
  }
  return changed ? nextRecord : record;
}

export function renameTag(state: UiState, tagId: string, nextName: string): UiState {
  const tag = state.tagById[tagId];
  const normalizedName = normalizeTagName(nextName);
  if (!tag || !normalizedName) {
    return state;
  }

  const nextTagId = tagIdFromName(normalizedName);
  if (nextTagId !== tagId && state.tagById[nextTagId]) {
    return state;
  }
  if (nextTagId === tagId && tag.name === normalizedName) {
    return state;
  }

  const nextTagById = { ...state.tagById };
  delete nextTagById[tagId];
  nextTagById[nextTagId] = {
    ...tag,
    id: nextTagId,
    name: normalizedName,
  };

  const nextTagExpandedById = { ...state.tagExpandedById };
  if (nextTagId !== tagId) {
    const expanded = nextTagExpandedById[tagId];
    delete nextTagExpandedById[tagId];
    if (expanded !== undefined) {
      nextTagExpandedById[nextTagId] = expanded;
    }
  }

  return {
    ...state,
    tagById: nextTagById,
    threadTagIdsByThreadKey:
      nextTagId === tagId
        ? state.threadTagIdsByThreadKey
        : replaceTagIdReferences(state.threadTagIdsByThreadKey, tagId, nextTagId),
    projectTagIdsByProjectKey:
      nextTagId === tagId
        ? state.projectTagIdsByProjectKey
        : replaceTagIdReferences(state.projectTagIdsByProjectKey, tagId, nextTagId),
    tagExpandedById: nextTagExpandedById,
  };
}

export function setTagColor(state: UiState, tagId: string, color: UiTagColor): UiState {
  const tag = state.tagById[tagId];
  if (!tag || tag.color === color) {
    return state;
  }
  return {
    ...state,
    tagById: {
      ...state.tagById,
      [tagId]: {
        ...tag,
        color,
      },
    },
  };
}

export function deleteTag(state: UiState, tagId: string): UiState {
  if (!state.tagById[tagId]) {
    return state;
  }
  const nextTagById = { ...state.tagById };
  const nextTagExpandedById = { ...state.tagExpandedById };
  delete nextTagById[tagId];
  delete nextTagExpandedById[tagId];
  const removeReference = (tagIds: string[]) =>
    tagIds.filter((currentTagId) => currentTagId !== tagId);
  const pruneRecord = (record: Record<string, string[]>) =>
    Object.fromEntries(
      Object.entries(record).flatMap(([recordKey, tagIds]) => {
        const nextTagIds = removeReference(tagIds);
        return nextTagIds.length > 0 ? [[recordKey, nextTagIds]] : [];
      }),
    );

  return {
    ...state,
    tagById: nextTagById,
    tagExpandedById: nextTagExpandedById,
    threadTagIdsByThreadKey: pruneRecord(state.threadTagIdsByThreadKey),
    projectTagIdsByProjectKey: pruneRecord(state.projectTagIdsByProjectKey),
  };
}

export function setTagExpanded(state: UiState, tagId: string, expanded: boolean): UiState {
  if ((state.tagExpandedById[tagId] ?? true) === expanded) {
    return state;
  }
  return {
    ...state,
    tagExpandedById: {
      ...state.tagExpandedById,
      [tagId]: expanded,
    },
  };
}

export function setDefaultAdvertisedEndpointKey(state: UiState, key: string | null): UiState {
  const nextKey = key && key.length > 0 ? key : null;
  if (state.defaultAdvertisedEndpointKey === nextKey) {
    return state;
  }
  return {
    ...state,
    defaultAdvertisedEndpointKey: nextKey,
  };
}

export function toggleProject(state: UiState, projectId: string): UiState {
  const expanded = state.projectExpandedById[projectId] ?? true;
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: !expanded,
    },
  };
}

export function setProjectExpanded(state: UiState, projectId: string, expanded: boolean): UiState {
  if ((state.projectExpandedById[projectId] ?? true) === expanded) {
    return state;
  }
  return {
    ...state,
    projectExpandedById: {
      ...state.projectExpandedById,
      [projectId]: expanded,
    },
  };
}

export function reorderProjects(
  state: UiState,
  draggedProjectIds: readonly string[],
  targetProjectIds: readonly string[],
): UiState {
  if (draggedProjectIds.length === 0) {
    return state;
  }
  const draggedSet = new Set(draggedProjectIds);
  const targetSet = new Set(targetProjectIds);
  if (draggedProjectIds.every((id) => targetSet.has(id))) {
    return state;
  }

  const originalTargetIndex = state.projectOrder.findIndex((id) => targetSet.has(id));
  if (originalTargetIndex < 0) {
    return state;
  }

  const projectOrder = [...state.projectOrder];

  const removed: string[] = [];
  let draggedBeforeTarget = 0;
  for (let i = projectOrder.length - 1; i >= 0; i--) {
    if (draggedSet.has(projectOrder[i]!)) {
      removed.unshift(projectOrder.splice(i, 1)[0]!);
      if (i < originalTargetIndex) {
        draggedBeforeTarget++;
      }
    }
  }
  if (removed.length === 0) {
    return state;
  }

  const insertIndex = originalTargetIndex - Math.max(0, draggedBeforeTarget - 1);
  projectOrder.splice(insertIndex, 0, ...removed);
  return {
    ...state,
    projectOrder,
  };
}

interface UiStateStore extends UiState {
  setSidebarViewMode: (mode: SidebarViewMode) => void;
  syncProjects: (projects: readonly SyncProjectInput[]) => void;
  syncThreads: (threads: readonly SyncThreadInput[]) => void;
  markThreadVisited: (threadId: string, visitedAt?: string) => void;
  markThreadUnread: (threadId: string, latestTurnCompletedAt: string | null | undefined) => void;
  clearThreadUi: (threadId: string) => void;
  setThreadPinned: (threadId: string, pinned: boolean, pinnedAt?: string) => void;
  addTagToThread: (threadKey: string, tagName: string, createdAt?: string) => void;
  removeTagFromThread: (threadKey: string, tagId: string) => void;
  addTagToProject: (projectKey: string, tagName: string, createdAt?: string) => void;
  removeTagFromProject: (projectKey: string, tagId: string) => void;
  renameTag: (tagId: string, nextName: string) => void;
  setTagColor: (tagId: string, color: UiTagColor) => void;
  deleteTag: (tagId: string) => void;
  setTagExpanded: (tagId: string, expanded: boolean) => void;
  setDefaultAdvertisedEndpointKey: (key: string | null) => void;
  toggleProject: (projectId: string) => void;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  reorderProjects: (
    draggedProjectIds: readonly string[],
    targetProjectIds: readonly string[],
  ) => void;
}

export const useUiStateStore = create<UiStateStore>((set) => ({
  ...readPersistedState(),
  setSidebarViewMode: (mode) => set((state) => setSidebarViewMode(state, mode)),
  syncProjects: (projects) => set((state) => syncProjects(state, projects)),
  syncThreads: (threads) => set((state) => syncThreads(state, threads)),
  markThreadVisited: (threadId, visitedAt) =>
    set((state) => markThreadVisited(state, threadId, visitedAt)),
  markThreadUnread: (threadId, latestTurnCompletedAt) =>
    set((state) => markThreadUnread(state, threadId, latestTurnCompletedAt)),
  clearThreadUi: (threadId) => set((state) => clearThreadUi(state, threadId)),
  setThreadPinned: (threadId, pinned, pinnedAt) =>
    set((state) => setThreadPinned(state, threadId, pinned, pinnedAt)),
  addTagToThread: (threadKey, tagName, createdAt) =>
    set((state) => addTagToThread(state, threadKey, tagName, createdAt)),
  removeTagFromThread: (threadKey, tagId) =>
    set((state) => removeTagFromThread(state, threadKey, tagId)),
  addTagToProject: (projectKey, tagName, createdAt) =>
    set((state) => addTagToProject(state, projectKey, tagName, createdAt)),
  removeTagFromProject: (projectKey, tagId) =>
    set((state) => removeTagFromProject(state, projectKey, tagId)),
  renameTag: (tagId, nextName) => set((state) => renameTag(state, tagId, nextName)),
  setTagColor: (tagId, color) => set((state) => setTagColor(state, tagId, color)),
  deleteTag: (tagId) => set((state) => deleteTag(state, tagId)),
  setTagExpanded: (tagId, expanded) => set((state) => setTagExpanded(state, tagId, expanded)),
  setDefaultAdvertisedEndpointKey: (key) =>
    set((state) => setDefaultAdvertisedEndpointKey(state, key)),
  toggleProject: (projectId) => set((state) => toggleProject(state, projectId)),
  setProjectExpanded: (projectId, expanded) =>
    set((state) => setProjectExpanded(state, projectId, expanded)),
  reorderProjects: (draggedProjectIds, targetProjectIds) =>
    set((state) => reorderProjects(state, draggedProjectIds, targetProjectIds)),
}));

useUiStateStore.subscribe((state) => debouncedPersistState.maybeExecute(state));

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    debouncedPersistState.flush();
  });
}
