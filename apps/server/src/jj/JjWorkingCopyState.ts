/**
 * What T3 knows about one jj working copy: which runs have a turn open in it,
 * who changed each unsealed file, and the jj operations T3 ran there. Several
 * threads can share a checkout, so files in `@` are attributed per path from
 * the paths providers report and from time slices in which only one turn ran.
 *
 * Stored as `.jj/t3/working-copy.json`. Every write happens under the working
 * copy's lock in JjCli.
 *
 * @module JjWorkingCopyState
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { JjChangeFlag } from "@t3tools/contracts";

const ActiveRun = Schema.Struct({
  runId: Schema.String,
  threadId: Schema.String,
  ordinal: Schema.Number,
  /** `@` when the turn started; changes the agent created descend from it. */
  startCommit: Schema.NullOr(Schema.String),
  /** The operation the turn started at; changes that existed then are not the agent's. */
  startOperation: Schema.optional(Schema.String),
  /** The turn's cwd, which relative reported paths start from. */
  cwd: Schema.optional(Schema.String),
  /** Another thread's turn ran here at the same time, so untagged commits are not provably ours. */
  shared: Schema.optional(Schema.Boolean),
});
export type ActiveRun = typeof ActiveRun.Type;

const PathOwner = Schema.Struct({
  runId: Schema.NullOr(Schema.String),
  threadId: Schema.String,
  ordinal: Schema.Number,
  source: Schema.Literals(["reported", "slice", "assigned"]),
  /** Another run edited the file too before it was sealed. */
  mixed: Schema.optional(Schema.Boolean),
});
export type PathOwner = typeof PathOwner.Type;

/** One thing T3 did, as the jj operations before and after it. */
const RecordedOperation = Schema.Struct({ before: Schema.String, after: Schema.String });
export type RecordedOperation = typeof RecordedOperation.Type;

const WorkingCopyState = Schema.Struct({
  /** `@` at the last observation; changes since then are attributed next time. */
  lastCommit: Schema.NullOr(Schema.String),
  active: Schema.Record(Schema.String, ActiveRun),
  /**
   * Unsealed files in `@`. `null` means several turns ran when the file changed
   * and none reported it; a file changed while no turn ran has no entry.
   */
  owners: Schema.Record(Schema.String, Schema.NullOr(PathOwner)),
  /** Flags per change id, shown in the stack. */
  flags: Schema.Record(Schema.String, Schema.Array(JjChangeFlag)),
  /** What T3 did here, oldest first, for undo. */
  operations: Schema.Array(RecordedOperation),
  /**
   * Thread per change id for the changes T3 knows a thread made: its seals,
   * and its agent's commits from turns no other thread shared. Revert abandons
   * only these and changes with the thread's trailer, so work T3 cannot
   * attribute is never discarded.
   */
  changes: Schema.Record(Schema.String, Schema.String),
  /**
   * Paths in a recorded change that other threads' turns also wrote: files an
   * agent's commit swept up, or files several turns edited before a seal.
   * Revert keeps such a change and restores only the thread's other paths.
   */
  foreignPaths: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});
export type WorkingCopyState = typeof WorkingCopyState.Type;

const MAX_RECORDED_OPERATIONS = 50;
const MAX_RECORDED_CHANGES = 1000;

const emptyWorkingCopyState: WorkingCopyState = {
  lastCommit: null,
  active: {},
  owners: {},
  flags: {},
  operations: [],
  changes: {},
  foreignPaths: {},
};

const StateJson = Schema.fromJsonString(WorkingCopyState);
const decodeState = Schema.decodeUnknownOption(StateJson);
const encodeState = Schema.encodeEffect(StateJson);

/** The platform services state persistence needs, captured when a service is built. */
export interface StateIo {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/**
 * Assigns each path that changed between two observations. A path a single
 * running turn reported is that turn's; a path changed while only one turn ran
 * is that turn's; anything else keeps its earlier owner, or is marked
 * unattributed when several turns were running.
 */
export function attributeChangedPaths(
  state: WorkingCopyState,
  changedPaths: ReadonlyArray<string>,
  reportedPaths: (runId: string) => ReadonlySet<string>,
): WorkingCopyState["owners"] {
  const active = Object.values(state.active);
  const owners = { ...state.owners };
  const ownerFor = (run: ActiveRun, source: PathOwner["source"]): PathOwner => ({
    runId: run.runId,
    threadId: run.threadId,
    ordinal: run.ordinal,
    source,
  });
  for (const path of changedPaths) {
    const reporters = active.filter((run) => reportedPaths(run.runId).has(path));
    const previous = Object.hasOwn(owners, path) ? owners[path] : undefined;
    if (reporters.length === 1) {
      const reporter = reporters[0]!;
      const mixed =
        (previous != null && previous.threadId !== reporter.threadId) || previous?.mixed === true;
      owners[path] = { ...ownerFor(reporter, "reported"), ...(mixed ? { mixed: true } : {}) };
    } else if (reporters.length > 1) {
      const kept = previous != null && reporters.some((run) => run.runId === previous.runId);
      owners[path] = { ...(kept ? previous : ownerFor(reporters[0]!, "reported")), mixed: true };
    } else if (previous !== undefined) {
      owners[path] = previous;
    } else if (active.length === 1) {
      owners[path] = ownerFor(active[0]!, "slice");
    } else if (active.length > 1) {
      owners[path] = null;
    }
    // A change made while no turn ran stays unowned; the next seal with no
    // other thread around takes it.
  }
  return owners;
}

/**
 * The files a run's seal commits: those attributed to it or to its thread,
 * plus unowned ones when no other thread is involved. Unattributed files stay.
 */
export function selectSealPaths(
  state: WorkingCopyState,
  run: Pick<ActiveRun, "runId" | "threadId">,
  changedInWorkingCopy: ReadonlyArray<string>,
): { readonly paths: ReadonlyArray<string>; readonly mixedPaths: ReadonlyArray<string> } {
  const otherThreadInvolved =
    Object.values(state.active).some((other) => other.threadId !== run.threadId) ||
    Object.values(state.owners).some((owner) => owner != null && owner.threadId !== run.threadId);
  const mixedPaths: Array<string> = [];
  const paths = changedInWorkingCopy.filter((path) => {
    const owner = state.owners[path];
    // Ambiguous files wait for someone to assign them.
    if (owner === null) return false;
    if (owner === undefined) return !otherThreadInvolved;
    const ours =
      owner.runId === run.runId ||
      (owner.threadId === run.threadId &&
        (owner.runId === null || state.active[owner.runId] === undefined));
    if (ours && owner.mixed) mixedPaths.push(path);
    return ours;
  });
  return { paths, mixedPaths };
}

/** Drops owners for files no longer changed in `@`, and for files just sealed. */
export function pruneOwners(
  owners: WorkingCopyState["owners"],
  changedInWorkingCopy: ReadonlyArray<string>,
  sealed: ReadonlyArray<string> = [],
): WorkingCopyState["owners"] {
  const still = new Set(changedInWorkingCopy);
  for (const path of sealed) still.delete(path);
  return Object.fromEntries(Object.entries(owners).filter(([path]) => still.has(path)));
}

export function recordOperation(
  state: WorkingCopyState,
  operation: RecordedOperation,
): WorkingCopyState {
  if (operation.before === operation.after) return state;
  return {
    ...state,
    operations: [...state.operations, operation].slice(-MAX_RECORDED_OPERATIONS),
  };
}

/** Records that a thread made a change, keeping the newest records. */
export function recordChange(
  state: WorkingCopyState,
  changeId: string,
  threadId: string,
): WorkingCopyState {
  const { [changeId]: _previous, ...rest } = state.changes;
  const changes = Object.fromEntries(
    [...Object.entries(rest), [changeId, threadId] as const].slice(-MAX_RECORDED_CHANGES),
  );
  const foreignPaths = Object.fromEntries(
    Object.entries(state.foreignPaths).filter(([recorded]) => Object.hasOwn(changes, recorded)),
  );
  return { ...state, changes, foreignPaths };
}

/** Records paths of a change that other threads' turns wrote too. */
export function addForeignPaths(
  state: WorkingCopyState,
  changeId: string,
  paths: ReadonlyArray<string>,
): WorkingCopyState {
  if (paths.length === 0) return state;
  const existing = state.foreignPaths[changeId] ?? [];
  return {
    ...state,
    foreignPaths: { ...state.foreignPaths, [changeId]: [...new Set([...existing, ...paths])] },
  };
}

export function addFlag(
  state: WorkingCopyState,
  changeId: string,
  flag: (typeof JjChangeFlag)["Type"],
): WorkingCopyState {
  const existing = state.flags[changeId] ?? [];
  if (existing.includes(flag)) return state;
  return { ...state, flags: { ...state.flags, [changeId]: [...existing, flag] } };
}

const statePath = (path: Path.Path, root: string) =>
  path.join(root, ".jj", "t3", "working-copy.json");

export const loadWorkingCopyState = Effect.fn("JjWorkingCopyState.load")(function* (
  io: StateIo,
  root: string,
) {
  const raw = yield* io.fileSystem
    .readFileString(statePath(io.path, root))
    .pipe(Effect.orElseSucceed(() => null));
  if (raw === null) return emptyWorkingCopyState;
  const decoded = decodeState(raw);
  return decoded._tag === "Some" ? decoded.value : emptyWorkingCopyState;
});

export const saveWorkingCopyState = Effect.fn("JjWorkingCopyState.save")(function* (
  io: StateIo,
  root: string,
  state: WorkingCopyState,
) {
  const file = statePath(io.path, root);
  const temporary = `${file}.tmp`;
  yield* io.fileSystem.makeDirectory(io.path.dirname(file), { recursive: true });
  yield* io.fileSystem.writeFileString(temporary, yield* encodeState(state));
  yield* io.fileSystem.rename(temporary, file);
});
