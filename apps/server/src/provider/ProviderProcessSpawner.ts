// @effect-diagnostics nodeBuiltinImport:off -- Claude's SDK requires a synchronous Node-compatible spawn callback.
import * as NodeChildProcess from "node:child_process";

import {
  projectExecutionArguments,
  resolveProjectExecution,
  type SeparateProjectProvider,
} from "../project/ProjectExecution.ts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const SYSTEMD_SCOPE_ENV = "T3_PROVIDER_SYSTEMD_SCOPE";
const SYSTEMD_SCOPE_PREFIX = "t3-provider";
const SYSTEMD_PROVIDER_SLICE = "t3-providers.slice";

export const shouldUseProviderSystemdScopes = (
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): boolean => platform === "linux" && environment[SYSTEMD_SCOPE_ENV] === "1";

const systemdScopeArguments = (scopeId: number, ownerId: string) => [
  "--user",
  "--scope",
  "--quiet",
  "--collect",
  `--slice=${SYSTEMD_PROVIDER_SLICE}`,
  `--unit=${SYSTEMD_SCOPE_PREFIX}-${ownerId}-${scopeId}`,
  "--property=TimeoutStopSec=15s",
  "--property=MemoryAccounting=yes",
  "--property=IOAccounting=yes",
];

export const makeSystemdScopedCommand = (
  command: ChildProcess.Command,
  scopeId: number,
  ownerId: string,
): ChildProcess.Command =>
  ChildProcess.prefix(command, "systemd-run", systemdScopeArguments(scopeId, ownerId));

export const make = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options: {
    readonly platform: NodeJS.Platform;
    readonly environment: NodeJS.ProcessEnv;
    readonly ownerId: string;
  },
): ChildProcessSpawner.ChildProcessSpawner["Service"] => {
  let nextScopeId = 0;
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const execution = yield* resolveProjectExecution(command, options.environment);
      return yield* spawner.spawn(
        shouldUseProviderSystemdScopes(options.platform, options.environment)
          ? makeSystemdScopedCommand(execution, ++nextScopeId, options.ownerId)
          : execution,
      );
    }),
  );
};

const makeOwnerId = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "");
});

/**
 * Keeps provider CLIs outside the T3 server unit's control group on managed
 * Linux hosts. It is opt-in so desktop installs and ordinary development keep
 * using the platform spawner directly.
 */
export const configured = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  return make(spawner, { platform, environment, ownerId: yield* makeOwnerId });
});

export const layer = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, configured);

interface NativeLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** Prefixes a launch with `systemd-run` so it starts in a fresh provider scope. */
export type NativeProviderScope = (launch: NativeLaunch) => NativeLaunch;

/**
 * The provider scope for processes that Node spawns directly instead of the
 * Effect spawner. Undefined unless the host opted into provider scopes.
 */
export const nativeScope = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  if (!shouldUseProviderSystemdScopes(platform, environment)) return undefined;
  const ownerId = yield* makeOwnerId;
  let nextScopeId = 0;
  const scope: NativeProviderScope = ({ command, args }) => ({
    command: "systemd-run",
    args: [...systemdScopeArguments(++nextScopeId, ownerId), command, ...args],
  });
  return scope;
});

/**
 * Claude's SDK spawns its CLI with Node itself. This starts it in the session's
 * project environment and its own provider scope, like processes from the
 * Effect spawner. Undefined when neither applies, so the SDK keeps its own
 * spawn, which also records stderr for exit errors.
 */
export function nativeProviderSpawn({
  scope,
  project,
}: {
  readonly scope: NativeProviderScope | undefined;
  readonly project?: SeparateProjectProvider | undefined;
}) {
  if (scope === undefined && project === undefined) return undefined;
  return (options: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd?: string | undefined;
    readonly env: NodeJS.ProcessEnv;
    readonly signal: AbortSignal;
  }) => {
    const launch =
      project === undefined
        ? options
        : {
            command: project.launcher,
            args: projectExecutionArguments(project.hostCwd, options.command, options.args),
          };
    const { command, args } = scope === undefined ? launch : scope(launch);
    return NodeChildProcess.spawn(command, args, {
      cwd: project?.hostCwd ?? options.cwd,
      env: options.env,
      signal: options.signal,
      // The SDK reads only stdin and stdout from a custom spawn. An unread
      // stderr pipe would block the CLI once it fills.
      stdio: ["pipe", "pipe", "ignore"],
    });
  };
}
