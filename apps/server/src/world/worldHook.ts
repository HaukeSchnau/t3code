// @effect-diagnostics nodeBuiltinImport:off -- shell paths resolve like the shell resolves them.
/**
 * Claude Code's PreToolUse hook for a thread world: before a Bash command
 * starts, check out every world repo it will run in, so installs, builds and dev servers never
 * start on the read-only view. Codex and anything the hook misses rely on the daemon's
 * check-out on `cd`.
 */
import * as NodePath from "node:path";

const CD_TARGET =
  /(?:^|&&|\|\||;|\||\n|\(|\bthen\b|\bdo\b)\s*(?:builtin\s+)?(?:cd|pushd)\s+("[^"]*"|'[^']*'|[^\s;&|()]+)/g;

function unquote(word: string): string {
  return (word.startsWith('"') && word.endsWith('"')) ||
    (word.startsWith("'") && word.endsWith("'"))
    ? word.slice(1, -1)
    : word;
}

/**
 * The directories `command` runs in: the session's cwd, then each `cd` or `pushd` target in
 * order, each resolved against the one before. Targets the hook cannot know, such as `cd -`,
 * a bare `cd`, or one built from variables, are skipped; the daemon's check-out on `cd`
 * still covers them.
 */
export function commandDirectories(command: string, cwd: string, home: string): string[] {
  const directories = [cwd];
  let current = cwd;
  for (const match of command.matchAll(CD_TARGET)) {
    const word = unquote(match[1] ?? "");
    if (word === "" || word === "-" || word.startsWith("-") || /[$`*?]/.test(word)) continue;
    const expanded =
      word === "~" ? home : word.startsWith("~/") ? NodePath.join(home, word.slice(2)) : word;
    current = NodePath.resolve(current, expanded);
    directories.push(current);
  }
  return directories;
}

/** Directories inside the world, below its top, each once. */
export function worldDirectories(directories: ReadonlyArray<string>, worldPath: string): string[] {
  const inside = directories.filter((directory) => {
    const relative = NodePath.relative(worldPath, directory);
    return relative !== "" && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
  });
  return [...new Set(inside)];
}

/** Codes that mean the command would run on the read-only view; anything else lets it run. */
const REFUSALS: ReadonlySet<string> = new Set(["cap", "missing-objects", "failed", "unknown-repo"]);

export type CheckoutOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface HookDenial {
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse";
    readonly permissionDecision: "deny";
    readonly permissionDecisionReason: string;
  };
}

/**
 * A readable denial when any checkout was refused. `outside` (the world's top or a folder
 * between repos) and a daemon that is down or doesn't know the thread let the command run.
 */
export function hookDecision(outcomes: ReadonlyArray<CheckoutOutcome>): HookDenial | undefined {
  const reasons = outcomes.flatMap((outcome) =>
    !outcome.ok && REFUSALS.has(outcome.code) ? [outcome.message] : [],
  );
  if (reasons.length === 0) return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `World checkout refused, so this command would run on the read-only view: ${reasons.join("; ")}. Push or drop the work in a repo you no longer need, so its checkout closes after 10 idle minutes, or ask the user to raise the cap.`,
    },
  };
}
