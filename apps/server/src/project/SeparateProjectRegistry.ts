// @effect-diagnostics nodeBuiltinImport:off -- shared on-disk launcher protocol uses canonical paths and SHA-256 identities.
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/** Detect registrations even if the launcher is missing, so isolated projects never silently run on the host. */
export async function isSeparateProject(cwd: string, stateDirectory?: string): Promise<boolean> {
  const state = stateDirectory ?? NodePath.join(NodeOS.homedir(), ".local/state/agent-exec");
  let candidate = await NodeFSP.realpath(cwd).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return NodePath.resolve(cwd);
    throw error;
  });
  while (true) {
    const id = NodeCrypto.createHash("sha256").update(candidate).digest("hex").slice(0, 20);
    const exists = await NodeFSP.stat(NodePath.join(state, "projects", `${id}.json`)).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (exists) return true;
    const parent = NodePath.dirname(candidate);
    if (candidate === parent) return false;
    candidate = parent;
  }
}

const Registration = Schema.fromJsonString(
  Schema.Struct({
    root: Schema.String,
    projectId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

const decodeRegistration = Schema.decodeUnknownSync(Registration);

/** Root changes need an explicit runtime migration, rather than silently dropping registration. */
export async function assertSeparateProjectRootUnchanged(
  projectId: string,
  root: string,
  stateDirectory?: string,
) {
  const directory = NodePath.join(
    stateDirectory ?? NodePath.join(NodeOS.homedir(), ".local/state/agent-exec"),
    "projects",
  );
  const files = await NodeFSP.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const record = decodeRegistration(
      await NodeFSP.readFile(NodePath.join(directory, file), "utf8"),
    );
    if (record.projectId === projectId && record.root !== root) {
      throw new Error(
        "Separate project directories cannot be moved through project settings. Request outside help to migrate the environment.",
      );
    }
  }
}
