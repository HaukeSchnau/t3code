import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { isSeparateProject } from "./SeparateProjectRegistry.ts";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

/** The host launcher resolves persistent project registrations by cwd. Unregistered paths pass through. */
export function projectExecutionArguments(cwd: string, command: string, args: readonly string[]) {
  return ["auto", "--cwd", cwd, "--", command, ...args];
}

export function withProjectExecution(
  command: ChildProcess.Command,
  launcher: string | undefined,
): ChildProcess.Command {
  if (!launcher) return command;
  if (command._tag === "PipedCommand") {
    return ChildProcess.pipeTo(
      withProjectExecution(command.left, launcher),
      withProjectExecution(command.right, launcher),
      command.options,
    );
  }
  const cwd = command.options.cwd;
  if (!cwd) return command;
  return ChildProcess.prefix(command, launcher, ["auto", "--cwd", cwd, "--"]);
}

/** Resolve before spawning so ordinary project commands avoid an extra launcher process. */
export const executionLauncherForCwd = Effect.fn("ProjectExecution.launcherForCwd")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const separate = yield* Effect.tryPromise({
    try: () => isSeparateProject(cwd, environment.AGENT_EXEC_STATE),
    catch: (cause) =>
      PlatformError.systemError({
        _tag: "Unknown",
        module: "ProjectExecution",
        method: "lookup",
        cause,
        description: "Could not inspect the project environment.",
      }),
  });
  if (!separate) return undefined;
  const launcher = environment.T3CODE_EXECUTION_LAUNCHER;
  if (!launcher)
    return yield* PlatformError.badArgument({
      module: "ProjectExecution",
      method: "launch",
      description: "This separate project requires the managed execution launcher.",
    });
  return launcher;
});

export const resolveProjectExecution = Effect.fn("ProjectExecution.resolve")(function* (
  command: ChildProcess.Command,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ChildProcess.Command, PlatformError.PlatformError> {
  if (command._tag === "PipedCommand") {
    const left = yield* resolveProjectExecution(command.left, environment);
    const right = yield* resolveProjectExecution(command.right, environment);
    return ChildProcess.pipeTo(left, right, command.options);
  }
  if (!command.options.cwd) return command;
  const launcher = yield* executionLauncherForCwd(command.options.cwd, environment);
  return withProjectExecution(command, launcher);
});
