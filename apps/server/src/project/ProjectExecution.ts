// @effect-diagnostics nodeBuiltinImport:off -- Claude's SDK requires a synchronous Node-compatible spawn callback.
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import { isSeparateProject, projectProviderView } from "./SeparateProjectRegistry.ts";
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

const inspectRegistry = <A>(lookup: () => Promise<A>) =>
  Effect.tryPromise({
    try: lookup,
    catch: (cause) =>
      PlatformError.systemError({
        _tag: "Unknown",
        module: "ProjectExecution",
        method: "lookup",
        cause,
        description: "Could not inspect the project environment.",
      }),
  });

const requireLauncher = (environment: NodeJS.ProcessEnv) => {
  const launcher = environment.T3CODE_EXECUTION_LAUNCHER;
  return launcher
    ? Effect.succeed(launcher)
    : Effect.fail(
        PlatformError.badArgument({
          module: "ProjectExecution",
          method: "launch",
          description: "This separate project requires the managed execution launcher.",
        }),
      );
};

/** Resolve before spawning so ordinary project commands avoid an extra launcher process. */
export const executionLauncherForCwd = Effect.fn("ProjectExecution.launcherForCwd")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const separate = yield* inspectRegistry(() =>
    isSeparateProject(cwd, environment.AGENT_EXEC_STATE),
  );
  return separate ? yield* requireLauncher(environment) : undefined;
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

const SEPARATE_PROJECT_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent"]);

/** Other providers' launch paths are unverified, so they must not start on the host instead. */
export const assertSeparateProjectDriver = Effect.fn("ProjectExecution.assertDriver")(function* (
  driver: string,
  cwd: string | null,
  environment: NodeJS.ProcessEnv,
) {
  if (cwd === null || SEPARATE_PROJECT_DRIVERS.has(driver)) return;
  if ((yield* executionLauncherForCwd(cwd, environment)) === undefined) return;
  return yield* PlatformError.badArgument({
    module: "ProjectExecution",
    method: "provider",
    description:
      "This project runs in a separate environment, which only supports Codex and Claude. Switch the thread to one of them.",
  });
});

/**
 * A provider session for a registered project. The process launches through the launcher
 * in `hostCwd`; provider protocol paths and host integrations use the agent's view.
 * Undefined for unregistered cwds, which keep the provider's ordinary launch.
 */
export const resolveSeparateProjectProvider = Effect.fn("ProjectExecution.resolveProvider")(
  function* (cwd: string | null, environment: NodeJS.ProcessEnv) {
    if (cwd === null) return undefined;
    const view = yield* inspectRegistry(() =>
      projectProviderView(cwd, environment.AGENT_EXEC_STATE),
    );
    if (view === undefined) return undefined;
    return { ...view, hostCwd: cwd, launcher: yield* requireLauncher(environment) };
  },
);

export type SeparateProjectProvider = NonNullable<
  Effect.Success<ReturnType<typeof resolveSeparateProjectProvider>>
>;

/** Only the session's own directory is mapped; its process cannot see other host paths. */
export function separateProjectPolicy<Policy extends { readonly cwd: string | null }>(
  project: SeparateProjectProvider | undefined,
  policy: Policy,
): Policy {
  return project !== undefined && policy.cwd === project.hostCwd
    ? { ...policy, cwd: project.cwd }
    : policy;
}

/** Claude's SDK spawns its CLI itself; this launches it in the project environment instead. */
export function separateProjectSpawn(project: SeparateProjectProvider) {
  return (options: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv;
    readonly signal: AbortSignal;
  }) =>
    NodeChildProcess.spawn(
      project.launcher,
      projectExecutionArguments(project.hostCwd, options.command, options.args),
      {
        cwd: project.hostCwd,
        env: options.env,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
}
