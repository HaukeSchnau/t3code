import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveProjectExecution } from "../project/ProjectExecution.ts";

/**
 * Starts provider commands whose cwd is a registered separate project through
 * the project launcher (patches/separate-project-environments.md). Session
 * adapters that run inside an agent scope route their own launch and spawn it
 * without a cwd, so the launcher stays inside the scope.
 */
export const make = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  environment: NodeJS.ProcessEnv,
): ChildProcessSpawner.ChildProcessSpawner["Service"] =>
  ChildProcessSpawner.make((command) =>
    resolveProjectExecution(command, environment).pipe(Effect.flatMap(spawner.spawn)),
  );

export const layer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    return make(yield* ChildProcessSpawner.ChildProcessSpawner, yield* HostProcess.Environment);
  }),
);
