/**
 * Isolated workspaces through the infra `agent-exec` launcher. The launcher
 * owns cloning, private homes, mounts, networking and retirement; T3 asks it
 * to fork the project and reads back the registration that project execution
 * (`project/ProjectExecution.ts`) later uses to route processes.
 *
 * @module IsolatedWorkspaces
 */
import type { ManagedWorkspacesCapability, ProjectId, WorkspaceProfile } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { projectProviderView, readSeparateProject } from "../project/SeparateProjectRegistry.ts";
import { findRepositoryMarker, resolveJjStartRevision } from "./JjWorkspaces.ts";
import { slug } from "./WorkspaceNaming.ts";
import {
  ManagedWorkspaceError,
  runWorkspaceCommand,
  runWorkspaceCommandOrFail,
} from "./WorkspaceCommand.ts";

/** What the environment descriptor advertises to clients. */
export function managedWorkspacesCapability(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): ManagedWorkspacesCapability {
  return { isolated: isolatedWorkspacesAvailable(platform, environment) };
}

export function isolatedWorkspacesAvailable(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): boolean {
  return platform === "linux" && Boolean(environment.T3CODE_EXECUTION_LAUNCHER);
}

const decodeRegistration = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      root: Schema.String,
      workspace: Schema.Struct({
        id: Schema.optional(Schema.NullOr(Schema.String)),
        ready: Schema.optional(Schema.Boolean),
      }),
    }),
  ),
);

const fail = (operation: string, detail: string, cause?: unknown) =>
  new ManagedWorkspaceError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

const requireLauncher = Effect.fn("IsolatedWorkspaces.launcher")(function* (operation: string) {
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const launcher = environment.T3CODE_EXECUTION_LAUNCHER;
  if (!launcher || !isolatedWorkspacesAvailable(platform, environment)) {
    return yield* fail(operation, "This host cannot create or remove isolated workspaces.");
  }
  return launcher;
});

/** The launcher's `--name`: the agent sees the workspace at `~/<name>`. */
function isolatedVisibleName(projectRoot: string): string {
  const name = slug(projectRoot.split(/[\\/]/).at(-1) ?? "")
    .replaceAll(".", "-")
    .slice(0, 64);
  return /^[a-z0-9]/.test(name) ? name : `p${name}`.slice(0, 64);
}

/** Git sources start from origin like Git worktrees do, and fall back to the local base. */
const gitStartRevision = Effect.fn("IsolatedWorkspaces.gitStartRevision")(function* (input: {
  readonly source: string;
  readonly baseRef: string | undefined;
  readonly startFromOrigin: boolean;
}) {
  const local = input.baseRef ?? "HEAD";
  if (!input.startFromOrigin || input.baseRef === undefined) return local;
  const git = (args: ReadonlyArray<string>) =>
    runWorkspaceCommand({
      operation: "IsolatedWorkspaces.fetch",
      command: "git",
      args: ["-C", input.source, ...args],
      timeout: "3 minutes",
    });
  if ((yield* git(["remote", "get-url", "origin"])).code !== 0) return local;
  const fetched = yield* git(["fetch", "origin", input.baseRef]);
  if (fetched.code === 0) return "FETCH_HEAD";
  // `ls-remote --exit-code` exits 2 only when origin has no such ref.
  if ((yield* git(["ls-remote", "--exit-code", "origin", input.baseRef])).code === 2) return local;
  return yield* fail(
    "IsolatedWorkspaces.fetch",
    fetched.stderr.trim() || "Could not fetch the requested base revision.",
  );
});

export const createIsolatedWorkspace = Effect.fn("IsolatedWorkspaces.create")(function* (input: {
  readonly source: string;
  readonly destination: string;
  readonly projectId: ProjectId;
  readonly workspaceId: string;
  readonly profile: WorkspaceProfile;
  readonly baseRef?: string | undefined;
  readonly startFromOrigin?: boolean | undefined;
}) {
  const launcher = yield* requireLauncher("IsolatedWorkspaces.create");
  const environment = yield* HostProcessEnvironment;
  const marker = findRepositoryMarker(input.source);
  const revision =
    marker?.kind === "jj"
      ? ((yield* resolveJjStartRevision({
          repository: marker.root,
          baseRef: input.baseRef,
          startFromOrigin: input.startFromOrigin === true,
        })) ?? "@")
      : marker?.kind === "git"
        ? yield* gitStartRevision({
            source: input.source,
            baseRef: input.baseRef,
            startFromOrigin: input.startFromOrigin === true,
          })
        : "@";
  const sourceRegistration = yield* Effect.tryPromise({
    try: () => readSeparateProject(input.source, environment.AGENT_EXEC_STATE),
    catch: (cause) =>
      fail("IsolatedWorkspaces.create", "Could not inspect the project's environment.", cause),
  });
  const output = yield* runWorkspaceCommandOrFail({
    operation: "IsolatedWorkspaces.create",
    command: launcher,
    args: [
      "fork",
      input.source,
      input.destination,
      "--name",
      isolatedVisibleName(sourceRegistration?.workspace?.visibleRoot ?? input.source),
      "--revision",
      revision,
      "--profile",
      input.profile,
      "--workspace-id",
      input.workspaceId,
      "--project-id",
      input.projectId,
    ],
    timeout: "10 minutes",
  });
  const registration = yield* decodeRegistration(output).pipe(
    Effect.mapError((cause) =>
      fail("IsolatedWorkspaces.create", "The launcher returned an unreadable registration.", cause),
    ),
  );
  if (
    registration.root !== input.destination ||
    registration.workspace.id !== input.workspaceId ||
    registration.workspace.ready === false
  ) {
    return yield* fail(
      "IsolatedWorkspaces.create",
      "The launcher returned another workspace's registration.",
    );
  }
  return input.destination;
});

/** The registered isolated workspace containing `path`, if any. */
export const findIsolatedWorkspace = Effect.fn("IsolatedWorkspaces.find")(function* (path: string) {
  const environment = yield* HostProcessEnvironment;
  const record = yield* Effect.tryPromise({
    try: () => readSeparateProject(path, environment.AGENT_EXEC_STATE),
    catch: (cause) =>
      fail("IsolatedWorkspaces.find", "Could not inspect the workspace environment.", cause),
  });
  return record?.workspace === undefined ? null : record.root;
});

/** Retires the runtime and removes the checkout; the launcher checks source dependencies. */
export const deleteIsolatedWorkspace = Effect.fn("IsolatedWorkspaces.delete")(function* (
  root: string,
) {
  const launcher = yield* requireLauncher("IsolatedWorkspaces.delete");
  yield* runWorkspaceCommandOrFail({
    operation: "IsolatedWorkspaces.delete",
    command: launcher,
    args: ["retire", root, "--remove-checkout"],
    timeout: "2 minutes",
  });
});

/**
 * The paths a setup script sees. Inside an isolated workspace the source
 * project is not mounted and the checkout appears at its visible root, so both
 * variables name the workspace there.
 */
export const setupScriptPaths = Effect.fn("IsolatedWorkspaces.setupScriptPaths")(function* (input: {
  readonly projectRoot: string;
  readonly worktreePath: string;
}) {
  const environment = yield* HostProcessEnvironment;
  const view = yield* Effect.tryPromise({
    try: () => projectProviderView(input.worktreePath, environment.AGENT_EXEC_STATE),
    catch: (cause) =>
      fail(
        "IsolatedWorkspaces.setupScriptPaths",
        "Could not inspect the workspace environment.",
        cause,
      ),
  });
  return view === undefined || view.cwd === input.worktreePath
    ? input
    : { projectRoot: view.cwd, worktreePath: view.cwd };
});
