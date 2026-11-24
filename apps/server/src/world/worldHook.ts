// @effect-diagnostics nodeBuiltinImport:off -- shell paths resolve like the shell resolves them.
/**
 * Claude Code's PreToolUse hook for a thread world: before a Bash command
 * starts, check out every world repo it will run in, so installs, builds and dev servers never
 * start on the read-only view. Codex and anything the hook misses rely on the daemon's
 * check-out on `cd`.
 */
import * as NodePath from "node:path";

type Token = { readonly word: string } | { readonly op: string };

const OPERATORS = ["&&", "||", ";", "|", "&", "\n", "(", ")"];

/** Words and control operators, with quotes removed and quoted operators kept as text. */
function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let word: string | null = null;
  const flush = () => {
    if (word !== null) tokens.push({ word });
    word = null;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close === -1 ? command.length : close;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      let text = "";
      for (i++; i < command.length && command[i] !== '"'; i++) {
        const next = command[i + 1];
        // Bash drops the backslash only before these, and joins lines at an escaped newline.
        if (command[i] === "\\" && next !== undefined && '$`"\\\n'.includes(next)) {
          i++;
          if (next === "\n") continue;
        } else if (command[i] === "$" && next === "(") {
          tokens.push({ op: "$(" });
        } else if (command[i] === "`") {
          tokens.push({ op: "`" });
        }
        text += command[i];
      }
      word = (word ?? "") + text;
    } else if ((char === "$" && command[i + 1] === "(") || char === "`") {
      flush();
      tokens.push({ op: char === "`" ? "`" : "$(" });
      if (char === "$") i++;
    } else if (char === "\\" && i + 1 < command.length) {
      word = (word ?? "") + command[++i];
    } else if (char === " " || char === "\t") {
      flush();
    } else {
      const op = OPERATORS.find((candidate) => command.startsWith(candidate, i));
      if (op === undefined) {
        word = (word ?? "") + char;
      } else {
        flush();
        tokens.push({ op });
        i += op.length - 1;
      }
    }
  }
  flush();
  return tokens;
}

/** Words after which the next word is still a command. */
const PREFIXES: ReadonlySet<string> = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "{",
  "!",
  "builtin",
]);

/** Operators after which the shell's directory depends on what ran: the hook stops predicting. */
const AMBIGUOUS: ReadonlySet<string> = new Set(["||", "|", "&", "(", ")", "$(", "`"]);

/**
 * The directories `command` runs in: the session's cwd, then each `cd` or `pushd` target in
 * order, each resolved against the one before. It stops at `||`, a pipe, `&` or a subshell,
 * and skips targets it cannot know, such as `cd -`, a bare `cd`, or one built from variables;
 * the daemon's check-out on `cd` covers the rest.
 */
export function commandDirectories(command: string, cwd: string, home: string): string[] {
  const directories = [cwd];
  let current = cwd;
  let commandStart = true;
  let cdTarget = false;
  for (const token of tokenize(command)) {
    if ("op" in token) {
      if (AMBIGUOUS.has(token.op)) break;
      cdTarget = false;
      commandStart = true;
      continue;
    }
    const word = token.word;
    if (cdTarget) {
      cdTarget = false;
      if (word === "" || word.startsWith("-") || /[$`*?]/.test(word)) continue;
      const expanded =
        word === "~" ? home : word.startsWith("~/") ? NodePath.join(home, word.slice(2)) : word;
      current = NodePath.resolve(current, expanded);
      directories.push(current);
    } else if (commandStart) {
      if (PREFIXES.has(word)) continue;
      commandStart = false;
      cdTarget = word === "cd" || word === "pushd";
    }
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
