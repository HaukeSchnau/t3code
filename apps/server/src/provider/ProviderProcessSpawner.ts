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

export const makeSystemdScopedCommand = (
  command: ChildProcess.Command,
  scopeId: number,
  ownerId: string,
): ChildProcess.Command =>
  ChildProcess.prefix(command, "systemd-run", [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    `--slice=${SYSTEMD_PROVIDER_SLICE}`,
    `--unit=${SYSTEMD_SCOPE_PREFIX}-${ownerId}-${scopeId}`,
    "--property=TimeoutStopSec=15s",
    "--property=MemoryAccounting=yes",
    "--property=IOAccounting=yes",
  ]);

export const make = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options: {
    readonly platform: NodeJS.Platform;
    readonly environment: NodeJS.ProcessEnv;
    readonly ownerId: string;
  },
): ChildProcessSpawner.ChildProcessSpawner["Service"] => {
  if (!shouldUseProviderSystemdScopes(options.platform, options.environment)) {
    return spawner;
  }

  let nextScopeId = 0;
  return ChildProcessSpawner.make((command) =>
    spawner.spawn(makeSystemdScopedCommand(command, ++nextScopeId, options.ownerId)),
  );
};

/**
 * Keeps provider CLIs outside the T3 server unit's control group on managed
 * Linux hosts. It is opt-in so desktop installs and ordinary development keep
 * using the platform spawner directly.
 */
export const configured = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const crypto = yield* Crypto.Crypto;
  const ownerId = (yield* crypto.randomUUIDv4.pipe(Effect.orDie)).replaceAll("-", "");
  return make(spawner, { platform, environment, ownerId });
});

export const layer = Layer.effect(ChildProcessSpawner.ChildProcessSpawner, configured);
