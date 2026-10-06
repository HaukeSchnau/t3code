import type { ThreadId } from "@t3tools/contracts";

import { resolveOpenCodeConfigContent } from "../provider/opencodeRuntime.ts";
import type { MaterializedSkillRoot } from "./SkillPackCatalog.ts";

/**
 * What each provider adapter reads while it builds a thread's native session,
 * the same way it reads `McpProviderSession`. `SkillPacks.prepareTurn` fills it
 * before the turn opens the session; every read records the key the provider
 * received so the next turn can tell whether a loaded thread is stale.
 */
const scopesByThread = new Map<ThreadId, MaterializedSkillRoot>();
const loadedKeyByThread = new Map<ThreadId, string>();
let codexPackRoot: MaterializedSkillRoot | undefined;

/** Selected packs for one thread, or undefined for core only. */
export function setThreadSkillScope(
  threadId: ThreadId,
  scope: MaterializedSkillRoot | undefined,
): void {
  if (scope === undefined) scopesByThread.delete(threadId);
  else scopesByThread.set(threadId, scope);
}

/** Codex loads every pack skill once per process and hides the unselected ones per thread. */
export function setCodexPackRoot(root: MaterializedSkillRoot | undefined): void {
  codexPackRoot = root;
}

/** The scope key a provider last loaded for the thread; "" for core only. */
export function loadedSkillScopeKey(threadId: ThreadId): string | undefined {
  return loadedKeyByThread.get(threadId);
}

function takeThreadSkillScope(threadId: ThreadId): MaterializedSkillRoot | undefined {
  const scope = scopesByThread.get(threadId);
  loadedKeyByThread.set(threadId, scope?.key ?? "");
  return scope;
}

/** `skills/extraRoots/set` roots for a new Codex app-server process. */
export function codexSkillPackRoots(): ReadonlyArray<string> {
  return codexPackRoot === undefined ? [] : [codexPackRoot.skillsPath];
}

/**
 * `thread/start`, `thread/resume` and `thread/fork` config that disables the
 * pack skills this thread did not select. Empty without a catalog, so recorded
 * Codex frames stay unchanged.
 */
export function codexThreadSkillConfig(threadId: ThreadId | null): {
  readonly "skills.config"?: ReadonlyArray<{ readonly path: string; readonly enabled: false }>;
} {
  if (codexPackRoot === undefined) return {};
  const root = codexPackRoot;
  const selected = new Set(
    threadId === null ? [] : (takeThreadSkillScope(threadId)?.skillIds ?? []),
  );
  const hidden = root.skillIds.filter((skillId) => !selected.has(skillId));
  return hidden.length === 0
    ? {}
    : {
        // Codex canonicalizes both sides, so the symlinked path matches the loaded skill.
        "skills.config": hidden.map((skillId) => ({
          path: `${root.skillsPath}/${skillId}/SKILL.md`,
          enabled: false,
        })),
      };
}

/** Claude Agent SDK `plugins`. The stable plugin name exposes skills as `skills:<id>`. */
export function claudeSkillPackPlugins(threadId: ThreadId): {
  readonly plugins?: ReadonlyArray<{ readonly type: "local"; readonly path: string }>;
} {
  const scope = takeThreadSkillScope(threadId);
  return scope === undefined ? {} : { plugins: [{ type: "local", path: scope.pluginPath }] };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Adds the thread's skill directory to the `OPENCODE_CONFIG_CONTENT` of a
 * locally spawned OpenCode server, keeping caller-owned config.
 */
export function withOpenCodeSkillPacks(
  threadId: ThreadId,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const scope = takeThreadSkillScope(threadId);
  if (scope === undefined) return environment;
  const configContent = resolveOpenCodeConfigContent(environment);
  let parsed: unknown;
  try {
    parsed = JSON.parse(configContent);
  } catch {
    return environment;
  }
  if (!isJsonObject(parsed)) return environment;
  const skills = isJsonObject(parsed.skills) ? parsed.skills : {};
  const paths = Array.isArray(skills.paths)
    ? skills.paths.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    ...environment,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...parsed,
      skills: { ...skills, paths: [...new Set([...paths, scope.skillsPath])] },
    }),
  };
}
