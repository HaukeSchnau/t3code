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
    home: Schema.optional(Schema.String),
    workspace: Schema.optional(
      Schema.Struct({
        visibleRoot: Schema.String,
        id: Schema.optional(Schema.NullOr(Schema.String)),
        sourceRevision: Schema.optional(Schema.String),
        profile: Schema.optional(Schema.Literals(["familiar", "minimal"])),
      }),
    ),
    projectId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

const decodeRegistration = Schema.decodeUnknownSync(Registration);

/** Resolve by the host workspace identity; identical paths in two namespaces are unrelated. */
export async function readSeparateProject(cwd: string, stateDirectory?: string) {
  const state = stateDirectory ?? NodePath.join(NodeOS.homedir(), ".local/state/agent-exec");
  const canonicalCwd = await NodeFSP.realpath(cwd).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return NodePath.resolve(cwd);
    throw error;
  });
  let candidate = canonicalCwd;
  while (true) {
    const id = NodeCrypto.createHash("sha256").update(candidate).digest("hex").slice(0, 20);
    const contents = await NodeFSP.readFile(
      NodePath.join(state, "projects", `${id}.json`),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (contents !== undefined) {
      const record = decodeRegistration(contents);
      if (record.root !== candidate) throw new Error("Invalid project environment root");
      return { ...record, canonicalCwd, state: NodePath.join(state, "environments", id) };
    }
    const parent = NodePath.dirname(candidate);
    if (candidate === parent) return undefined;
    candidate = parent;
  }
}

export async function projectProviderCwd(cwd: string, stateDirectory?: string) {
  const record = await readSeparateProject(cwd, stateDirectory);
  return record?.workspace
    ? NodePath.join(
        record.workspace.visibleRoot,
        NodePath.relative(record.root, record.canonicalCwd),
      )
    : cwd;
}

/** Setup journals live in the workspace's private home, visible to both the server and its PTY. */
export async function projectSetupPaths(
  cwd: string,
  serverJournalDirectory: string,
  stateDirectory?: string,
) {
  const record = await readSeparateProject(cwd, stateDirectory);
  const journalPath = ".local/state/t3/setup-executions";
  return {
    cwd: record?.workspace
      ? NodePath.join(
          record.workspace.visibleRoot,
          NodePath.relative(record.root, record.canonicalCwd),
        )
      : cwd,
    projectRoot: record ? (record.workspace?.visibleRoot ?? record.root) : undefined,
    journalDirectory: record
      ? NodePath.join(record.home ?? NodeOS.homedir(), journalPath)
      : serverJournalDirectory,
    hostJournalDirectory: record
      ? NodePath.join(record.state, "home", journalPath)
      : serverJournalDirectory,
  };
}

/** Explicit host integrations use the gateway; localhost remains private to the workspace. */
export async function projectProviderEndpoint(
  cwd: string | undefined,
  endpoint: string,
  stateDirectory?: string,
) {
  if (!cwd || !(await readSeparateProject(cwd, stateDirectory))?.workspace) return endpoint;
  const url = new URL(endpoint);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) url.hostname = "10.0.2.2";
  return url.toString();
}

function relativeWithin(root: string, path: string) {
  const relative = NodePath.relative(root, path);
  return relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
    ? undefined
    : relative;
}

/** Resolve namespace files for media and editor reads without falling back to unrelated host files. */
export async function projectHostPath(cwd: string, filePath: string, stateDirectory?: string) {
  const record = await readSeparateProject(cwd, stateDirectory);
  if (!record) return filePath;
  const home = record.home ?? NodeOS.homedir();
  const visibleRoot = record.workspace?.visibleRoot ?? record.root;
  const requested = NodePath.isAbsolute(filePath)
    ? NodePath.normalize(filePath)
    : NodePath.resolve(cwd, filePath);
  const mappings = [
    [record.root, record.root],
    [record.state, record.state],
    [
      NodePath.join(home, ".t3/userdata/attachments"),
      NodePath.join(home, ".t3/userdata/attachments"),
    ],
    [visibleRoot, record.root],
    ["/tmp", NodePath.join(record.state, "tmp")],
    [
      "/srv/agent-share",
      NodePath.join("/srv/agent-share/isolated", NodePath.basename(record.state)),
    ],
    [home, NodePath.join(record.state, "home")],
  ] as const;
  for (const [visible, actual] of mappings) {
    const relative = relativeWithin(visible, requested);
    if (relative === undefined) continue;
    const result = NodePath.join(actual, relative);
    // Host realpath must not follow a project symlink into another checkout.
    const canonical = await NodeFSP.realpath(result).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return result;
      throw error;
    });
    const actualRoot = await NodeFSP.realpath(actual).catch(() => actual);
    if (relativeWithin(actualRoot, canonical) === undefined)
      throw new Error("Environment file leaves its mounted directory");
    return canonical;
  }
  throw new Error("File is not visible in this project environment");
}

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
    if (record.projectId === projectId && !record.workspace?.id && record.root !== root) {
      throw new Error(
        "Separate project directories cannot be moved through project settings. Request outside help to migrate the environment.",
      );
    }
  }
}
