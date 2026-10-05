// @effect-diagnostics nodeBuiltinImport:off -- recursive removal needs chmod and lstat fallbacks.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

export class ManagedWorkspaceError extends Schema.TaggedError<ManagedWorkspaceError>()(
  "ManagedWorkspaceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

interface WorkspaceCommandInput {
  readonly operation: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeout?: Duration.Input;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Provisioning is a host operation, so commands run from `/` with explicit
 * repository paths. A cwd inside a registered isolated project would otherwise
 * be routed into that project's environment by ProcessRunner.
 */
export const runWorkspaceCommand = Effect.fn("WorkspaceCommand.run")(function* (
  input: WorkspaceCommandInput,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  return yield* runner
    .run({
      command: input.command,
      args: input.args,
      cwd: "/",
      timeout: input.timeout ?? Duration.minutes(1),
      maxOutputBytes: input.maxOutputBytes ?? 1024 * 1024,
      outputMode: "truncate",
      ...(input.env === undefined ? {} : { env: input.env }),
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ManagedWorkspaceError({
            operation: input.operation,
            detail: `Could not run ${input.command}: ${cause.message}`,
            cause,
          }),
      ),
    );
});

/** Like runWorkspaceCommand, but a non-zero exit fails with the command's stderr. */
export const runWorkspaceCommandOrFail = Effect.fn("WorkspaceCommand.runOrFail")(function* (
  input: WorkspaceCommandInput,
) {
  const result = yield* runWorkspaceCommand(input);
  if (result.code !== 0) {
    return yield* new ManagedWorkspaceError({
      operation: input.operation,
      detail:
        result.stderr.trim() ||
        result.stdout.trim() ||
        `${input.command} exited with ${result.code ?? "no exit code"}.`,
    });
  }
  return result.stdout.trim();
});

function makeUserWritable(path: string): void {
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    try {
      NodeFS.chmodSync(current, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
    } catch {
      // rmSync reports anything that stays unremovable.
    }
    if (!stat.isDirectory()) continue;
    try {
      for (const entry of NodeFS.readdirSync(current)) stack.push(NodePath.join(current, entry));
    } catch {
      continue;
    }
  }
}

/** Removes a workspace directory, including read-only trees such as Go or Nix caches. */
export const removeWorkspaceDirectory = (path: string) =>
  Effect.try({
    try: () => {
      try {
        NodeFS.rmSync(path, { recursive: true, force: true });
      } catch {
        makeUserWritable(path);
        NodeFS.rmSync(path, { recursive: true, force: true });
      }
    },
    catch: (cause) =>
      new ManagedWorkspaceError({
        operation: "WorkspaceCommand.removeDirectory",
        detail: `Could not remove '${path}'.`,
        cause,
      }),
  });
