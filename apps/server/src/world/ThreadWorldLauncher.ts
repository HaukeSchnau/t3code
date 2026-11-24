/**
 * Thread worlds through agent-exec (patches/worlds.md). agent-exec owns the thread's
 * namespaces and its registration with the worldfs daemon; T3 picks the host directory and the
 * daemon's thread key, and reads back the registration that routes the thread's processes.
 */
import {
  type ProjectId,
  type ThreadId,
  type WorldId,
  WorldLayoutRule,
  type WorldSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { readSeparateProject } from "../project/SeparateProjectRegistry.ts";
import { isolatedWorkspacesAvailable } from "../workspace/IsolatedWorkspaces.ts";
import { ManagedWorkspaceError, runWorkspaceCommandOrFail } from "../workspace/WorkspaceCommand.ts";
import { worldThreadKey } from "./threadWorldPaths.ts";

const decodeRegistration = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      root: Schema.String,
      workspace: Schema.Struct({ id: Schema.optional(Schema.NullOr(Schema.String)) }),
    }),
  ),
);

const encodeLayout = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(WorldLayoutRule)));

const fail = (operation: string, detail: string, cause?: unknown) =>
  new ManagedWorkspaceError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

const requireLauncher = Effect.fn("ThreadWorlds.launcher")(function* (operation: string) {
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const launcher = environment.T3CODE_EXECUTION_LAUNCHER;
  if (!launcher || !isolatedWorkspacesAvailable(platform, environment)) {
    return yield* fail(
      operation,
      "This host cannot run threads in a world. Worlds need Linux and the agent-exec launcher.",
    );
  }
  return launcher;
});

export interface ThreadWorldInput {
  readonly root: string;
  readonly world: WorldId;
  readonly settings: WorldSettings;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

/** `agent-exec world`, which creates the thread world or confirms an existing one. */
export const registerThreadWorld = Effect.fn("ThreadWorlds.register")(function* (
  input: ThreadWorldInput,
) {
  const launcher = yield* requireLauncher("ThreadWorlds.register");
  const thread = worldThreadKey(input.threadId);
  const output = yield* runWorkspaceCommandOrFail({
    operation: "ThreadWorlds.register",
    command: launcher,
    args: [
      "world",
      input.root,
      "--world",
      input.world,
      "--path",
      input.settings.path,
      "--thread",
      thread,
      "--project-id",
      input.projectId,
      ...(input.settings.layout.length === 0
        ? []
        : ["--layout", yield* encodeLayout(input.settings.layout).pipe(Effect.orDie)]),
    ],
    timeout: "2 minutes",
  });
  const registration = yield* decodeRegistration(output).pipe(
    Effect.mapError((cause) =>
      fail("ThreadWorlds.register", "agent-exec returned an unreadable registration.", cause),
    ),
  );
  if (registration.root !== input.root || registration.workspace.id !== thread) {
    return yield* fail(
      "ThreadWorlds.register",
      "agent-exec returned another thread world's registration.",
    );
  }
  return input.root;
});

/** The daemon's thread key of a registered thread world, or undefined before registration. */
export const registeredThreadKey = Effect.fn("ThreadWorlds.registeredKey")(function* (
  root: string,
) {
  const environment = yield* HostProcess.Environment;
  const record = yield* Effect.tryPromise({
    try: () => readSeparateProject(root, environment.AGENT_EXEC_STATE),
    catch: (cause) =>
      fail("ThreadWorlds.registeredKey", "Could not read the thread world's registration.", cause),
  });
  return record?.root === root ? (record.workspace?.id ?? undefined) : undefined;
});
