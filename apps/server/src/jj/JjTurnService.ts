/**
 * Turn boundaries in jj working copies. When a turn ends, T3 commits the files
 * that turn changed into a change of its own ("sealing"), so every turn leaves
 * a change behind even when the agent never commits. An agent that commits its
 * own work leaves nothing to seal. Changes carry T3-Thread and T3-Turn
 * trailers; reverting a thread abandons the changes it made after the
 * checkpoint and restores its files, leaving other threads' work in place.
 *
 * Seals run when the agent is idle, after the turn. Several threads may share
 * one checkout, so only the files attributed to the ending turn are sealed.
 * See JjWorkingCopyState for attribution.
 *
 * @module JjTurnService
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  type CheckpointRef,
  JJ_THREAD_TRAILER,
  JJ_TURN_TRAILER,
  JjActionError,
  type JjAssignPathsInput,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as JjCli from "../vcs/JjCli.ts";
import {
  jjFilesets,
  jjString,
  readCheckpointCommit,
  snapshotWorkingCopy,
  splitNul,
} from "../vcs/JjVcsDriver.ts";
import { findRepositoryMarker } from "../vcs/RepositoryMarker.ts";
import * as JjCommitWriter from "./JjCommitWriter.ts";
import { decodeJsonBoolean, decodeJsonString, decodeJsonStrings } from "./jjTemplateJson.ts";
import * as JjThreadLayer from "./JjThreadLayer.ts";
import {
  type ActiveRun,
  addFlag,
  addForeignPaths,
  attributeChangedPaths,
  loadWorkingCopyState,
  pruneOwners,
  recordOperation,
  saveWorkingCopyState,
  selectSealPaths,
  recordChange,
  type RecordedOperation,
  type WorkingCopyState,
} from "./JjWorkingCopyState.ts";

export class JjTurnError extends Schema.TaggedError<JjTurnError>()("JjTurnError", {
  operation: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const SIBLING_IDLE_TIMEOUT = Duration.minutes(30);
const ACTIVE_RUN_STATUSES = new Set(["starting", "running", "waiting"]);

export class JjTurnService extends Context.Service<
  JjTurnService,
  {
    /** Before the provider starts a turn. Does nothing outside jj working copies. */
    readonly turnStarted: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly ordinal: number;
      readonly cwd: string;
    }) => Effect.Effect<void>;
    /** After a turn ends in any state, before its checkpoint is captured. */
    readonly sealTurn: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly ordinal: number;
      readonly cwd: string;
      readonly failed: boolean;
    }) => Effect.Effect<void>;
    /** Whether `cwd` is a jj working copy T3 seals and reverts. */
    readonly isJjWorkingCopy: (cwd: string) => Effect.Effect<boolean>;
    /**
     * Checks that jj can restore the checkpoint, then waits until no other
     * thread has a turn running in the working copy.
     */
    readonly prepareRevert: (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly checkpointRef: CheckpointRef;
    }) => Effect.Effect<void, JjTurnError>;
    /**
     * Abandons the thread's changes made after the checkpoint and restores its
     * files in `@` to the checkpoint. Other threads' work stays.
     */
    readonly revert: (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly checkpointRef: CheckpointRef;
    }) => Effect.Effect<void, JjTurnError>;
    readonly assignPaths: (input: JjAssignPathsInput) => Effect.Effect<number, JjActionError>;
    readonly readState: (root: string) => Effect.Effect<WorkingCopyState>;
    /** Records what T3 did outside a turn, so undo can find it. */
    readonly recordOperation: (root: string, operation: RecordedOperation) => Effect.Effect<void>;
    /** Removes an undone operation from the record. */
    readonly forgetOperation: (root: string, after: string) => Effect.Effect<void>;
    /** Re-baselines attribution after T3 rewrote the working copy itself. */
    readonly rebaseline: (root: string) => Effect.Effect<void>;
    /**
     * The commit a fork's workspace starts from: `@-` when `@` is empty, which
     * the parent's own snapshots never rewrite. Null outside jj, or when `@`
     * holds changes; the fork then shares the parent's directory.
     */
    readonly forkBase: (cwd: string) => Effect.Effect<string | null>;
    /**
     * Moves a fork's changes from its own workspace into its parent's stack,
     * below the parent's working copy. Refuses while the parent has a turn
     * running there. Workspaces of different repositories are left alone.
     */
    readonly mergeBack: (input: {
      readonly forkCwd: string;
      readonly parentCwd: string;
    }) => Effect.Effect<void, JjTurnError>;
  }
>()("t3/jj/JjTurnService") {}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const THREAD_TRAILER_LINE = new RegExp(`^${JJ_THREAD_TRAILER}: (.+)$`, "gm");

const trailerThreads = (description: string) =>
  [...description.matchAll(THREAD_TRAILER_LINE)].map((match) => match[1]!.trim());

export const threadTrailerRevset = (threadId: string) =>
  `description(regex:${jjString(`(?m)^${JJ_THREAD_TRAILER}: ${escapeRegex(threadId)}$`)})`;

/** Appends T3 trailers to a description, in its last paragraph. */
export function withTrailers(description: string, threadId: string, ordinal: number): string {
  const lines = description.replace(/\s+$/, "").split("\n");
  const additions = [`${JJ_THREAD_TRAILER}: ${threadId}`, `${JJ_TURN_TRAILER}: ${ordinal}`].filter(
    (line) => !lines.includes(line),
  );
  if (additions.length === 0) return `${lines.join("\n")}\n`;
  const last = lines.at(-1) ?? "";
  const endsWithTrailers = lines.length > 1 && /^[A-Za-z0-9-]+: /.test(last);
  return `${[...lines, ...(endsWithTrailers ? [] : [""]), ...additions].join("\n")}\n`;
}

interface AgentChange {
  readonly changeId: string;
  readonly commitId: string;
  readonly description: string;
  readonly files: ReadonlyArray<string>;
  readonly pushed: boolean;
}

interface DescribeLater {
  readonly root: string;
  readonly threadId: ThreadId;
  readonly ordinal: number;
  readonly changeId: string;
  readonly provisional: string;
  readonly trailers: boolean;
  readonly failed: boolean;
}

const make = Effect.gen(function* () {
  const jj = yield* JjCli.JjCli;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const threadLayer = yield* JjThreadLayer.JjThreadLayer;
  const writer = yield* JjCommitWriter.JjCommitWriter;
  const path = yield* Path.Path;
  const io = { fileSystem: yield* FileSystem.FileSystem, path };
  const changed = yield* Ref.make(yield* Deferred.make<void>());

  const notify = Effect.gen(function* () {
    const next = yield* Deferred.make<void>();
    const previous = yield* Ref.getAndSet(changed, next);
    yield* Deferred.succeed(previous, undefined);
  });

  const jjRoot = (cwd: string) =>
    Effect.gen(function* () {
      const marker = findRepositoryMarker(cwd);
      if (marker?.kind !== "jj" || !(yield* jj.supported)) return null;
      return marker.root;
    });

  const isJjWorkingCopy: JjTurnService["Service"]["isJjWorkingCopy"] = (cwd) =>
    Effect.map(jjRoot(cwd), (root) => root !== null);

  const trailersEnabled = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      const thread = yield* projections
        .getThreadShell(threadId)
        .pipe(Effect.orElseSucceed(() => null));
      return resolveProjectSettings(settings, thread?.projectId ?? null).settings.jjCommitTrailers;
    }).pipe(Effect.orElseSucceed(() => true));

  const readRevision = (root: string, operation: string, revision: string, template: string) =>
    jj.read({
      operation,
      root,
      args: ["--ignore-working-copy", "log", "--no-graph", "-r", revision, "-T", template],
    });

  const operationHead = (root: string) =>
    jj.read({
      operation: "JjTurnService.operationHead",
      root,
      args: ["--ignore-working-copy", "op", "log", "-n", "1", "--no-graph", "-T", "id"],
    });

  const workingCopyCommit = (root: string) =>
    readRevision(root, "JjTurnService.workingCopyCommit", "@", "commit_id");

  /** Paths changed in `@` relative to its parent, both sides of renames. */
  const changedInWorkingCopy = (root: string) =>
    jj
      .run({
        operation: "JjTurnService.changedInWorkingCopy",
        root,
        args: [
          "--ignore-working-copy",
          "diff",
          "-r",
          "@",
          "-T",
          'source.path() ++ "\\0" ++ path ++ "\\0"',
        ],
        maxOutputBytes: 8_000_000,
      })
      .pipe(Effect.map((result) => [...new Set(splitNul(result.stdout))]));

  /** Paths each run's provider reported editing, relative to the workspace root. */
  const reportedPaths = Effect.fn("JjTurnService.reportedPaths")(function* (
    root: string,
    active: ReadonlyArray<ActiveRun>,
  ) {
    const byRun = new Map<string, Set<string>>();
    for (const run of active) {
      const records = yield* projections
        .getThreadRecords(run.threadId as ThreadId, ["turnItems"], {
          turnItemRunIds: [run.runId as RunId],
          turnItemTypes: ["file_change"],
        })
        .pipe(Effect.orElseSucceed(() => null));
      const paths = new Set<string>();
      for (const item of records?.turnItems ?? []) {
        if (item.type !== "file_change") continue;
        const candidates = [
          item.fileName,
          ...(item.changes ?? []).flatMap((change) => [change.path, change.oldPath]),
        ];
        for (const candidate of candidates) {
          if (candidate === undefined) continue;
          const absolute = path.isAbsolute(candidate)
            ? candidate
            : path.resolve(run.cwd ?? root, candidate);
          const relative = path.relative(root, absolute);
          if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
            paths.add(relative.split(path.sep).join("/"));
          }
        }
      }
      byRun.set(run.runId, paths);
    }
    return byRun;
  });

  /** Drops runs a restart or crash left behind; `keep` stays even though it just ended. */
  const pruneFinishedRuns = (state: WorkingCopyState, keep?: string) =>
    Effect.gen(function* () {
      const active: Record<string, ActiveRun> = {};
      for (const run of Object.values(state.active)) {
        if (run.runId === keep) {
          active[run.runId] = run;
          continue;
        }
        const records = yield* projections
          .getThreadRecords(run.threadId as ThreadId, ["runs"], { runIds: [run.runId as RunId] })
          .pipe(Effect.orElseSucceed(() => null));
        const status = records?.runs.find((candidate) => candidate.id === run.runId)?.status;
        if (status !== undefined && ACTIVE_RUN_STATUSES.has(status)) active[run.runId] = run;
      }
      return { ...state, active };
    });

  /** Snapshots and attributes everything that changed since the last observation. */
  const observe = Effect.fn("JjTurnService.observe")(function* (
    root: string,
    state: WorkingCopyState,
  ) {
    const commit = yield* snapshotWorkingCopy(jj, root, "JjTurnService.observe");
    if (state.lastCommit === commit) return state;
    if (state.lastCommit === null) return { ...state, lastCommit: commit };
    const diff = yield* jj
      .git({
        operation: "JjTurnService.observe.diff",
        root,
        args: ["diff", "--name-only", "-z", "--no-renames", state.lastCommit, commit],
        allowNonZeroExit: true,
        maxOutputBytes: 8_000_000,
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (diff === null || diff.exitCode !== 0) return { ...state, lastCommit: commit };
    const reported = yield* reportedPaths(root, Object.values(state.active));
    const owners = attributeChangedPaths(
      state,
      splitNul(diff.stdout),
      (runId) => reported.get(runId) ?? new Set(),
    );
    return { ...state, owners, lastCommit: commit };
  });

  const withState = <A, E, R>(
    root: string,
    body: (state: WorkingCopyState) => Effect.Effect<readonly [A, WorkingCopyState], E, R>,
  ) =>
    jj.withWorkingCopyLock(
      root,
      Effect.gen(function* () {
        const state = yield* loadWorkingCopyState(io, root);
        const [result, next] = yield* body(state);
        yield* saveWorkingCopyState(io, root, next);
        return result;
      }),
    );

  const turnStarted: JjTurnService["Service"]["turnStarted"] = (input) =>
    Effect.gen(function* () {
      const root = yield* jjRoot(input.cwd);
      if (root === null) return;
      yield* threadLayer.writeForTurn({
        threadId: input.threadId,
        ordinal: input.ordinal,
        trailers: yield* trailersEnabled(input.threadId),
      });
      yield* withState(root, (initial) =>
        Effect.gen(function* () {
          const state = yield* observe(root, yield* pruneFinishedRuns(initial));
          const shared = Object.values(state.active).some(
            (other) => other.threadId !== input.threadId,
          );
          const run: ActiveRun = {
            runId: input.runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            startCommit: state.lastCommit,
            startOperation: yield* operationHead(root),
            cwd: path.resolve(input.cwd),
            ...(shared ? { shared: true } : {}),
          };
          const active = Object.fromEntries(
            Object.entries(state.active).map(([runId, other]) => [
              runId,
              other.threadId === input.threadId ? other : { ...other, shared: true },
            ]),
          );
          return [undefined, { ...state, active: { ...active, [input.runId]: run } }] as const;
        }),
      );
      yield* notify;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("jj turn start bookkeeping failed", { runId: input.runId, cause }),
      ),
    );

  /**
   * Changes the agent made during the turn. A change that existed when the
   * turn started is not the agent's, except the turn's own `@`, which the
   * agent's commands describe or commit in place. Neither is a change T3
   * recorded or tagged for another thread. When another thread's turn shared
   * the working copy, only commits with this thread's trailer are provably
   * the agent's.
   */
  const agentChanges = (root: string, run: ActiveRun, state: WorkingCopyState) =>
    Effect.gen(function* () {
      if (run.startCommit === null) return [];
      const candidates = yield* readRevision(
        root,
        "JjTurnService.agentChanges",
        `(${run.startCommit}..@-) & mutable()`,
        'json(change_id) ++ "\\t" ++ json(commit_id) ++ "\\t" ++ json(description) ++ "\\t" ++ json(diff.files().map(|f| f.path())) ++ "\\t" ++ json(self.contained_in("::remote_bookmarks()")) ++ "\\n"',
      ).pipe(
        Effect.flatMap((output) =>
          Effect.try(() =>
            output
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line): AgentChange => {
                const [changeId = "", commitId = "", description = "", files = "", pushed = ""] =
                  line.split("\t");
                return {
                  changeId: decodeJsonString(changeId),
                  commitId: decodeJsonString(commitId),
                  description: decodeJsonString(description),
                  files: decodeJsonStrings(files),
                  pushed: decodeJsonBoolean(pushed),
                };
              }),
          ),
        ),
      );
      if (candidates.length === 0) return [];
      const startChange = yield* readRevision(
        root,
        "JjTurnService.startChange",
        run.startCommit,
        "change_id",
      );
      const existed =
        run.startOperation === undefined
          ? null
          : new Set(
              (yield* jj.read({
                operation: "JjTurnService.existedAtStart",
                root,
                args: [
                  "--at-op",
                  run.startOperation,
                  "log",
                  "--no-graph",
                  "-r",
                  candidates.map((change) => `present(change_id(${change.changeId}))`).join(" | "),
                  "-T",
                  'change_id ++ "\\n"',
                ],
              })).split("\n"),
            );
      const provable = existed !== null && run.shared !== true;
      return candidates.filter((change) => {
        if (change.changeId !== startChange && existed?.has(change.changeId) === true) return false;
        const recorded = state.changes[change.changeId];
        if (recorded !== undefined && recorded !== run.threadId) return false;
        const threads = trailerThreads(change.description);
        if (threads.some((thread) => thread !== run.threadId)) return false;
        return provable || threads.includes(run.threadId);
      });
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<AgentChange> => []));

  /** Whether another workspace's `@` descends from the change, so rewriting it would make that workspace stale. */
  const otherWorkspacesBuildOn = (root: string, changeId: string) =>
    readRevision(
      root,
      "JjTurnService.otherWorkspacesBuildOn",
      `(change_id(${changeId}):: & working_copies()) ~ @`,
      'change_id ++ "\\n"',
    ).pipe(
      Effect.map((output) => output.length > 0),
      Effect.orElseSucceed(() => true),
    );

  // Rewrites snapshot first: skipping the working copy would leave it stale.
  const describe = (root: string, operation: string, revision: string, message: string) =>
    jj.run({
      operation,
      root,
      args: ["describe", "-r", revision, "-m", message],
    });

  /** Replaces a seal's provisional message with the commit writer's, unless someone edited it. */
  const describeLater = (input: DescribeLater) =>
    Effect.gen(function* () {
      const message = yield* writer.commitMessage({
        root: input.root,
        threadId: input.threadId,
        revision: `change_id(${input.changeId})`,
      });
      if (message === null) return;
      yield* jj.withWorkingCopyLock(
        input.root,
        Effect.gen(function* () {
          const current = yield* readRevision(
            input.root,
            "JjTurnService.describeLater.current",
            `change_id(${input.changeId})`,
            "description",
          );
          if (current.trim() !== input.provisional.trim()) return;
          // A fork's workspace may start here; the provisional message stays.
          if (yield* otherWorkspacesBuildOn(input.root, input.changeId)) return;
          const body = [message.body, input.failed ? "Turn ended with an error." : ""]
            .filter((part) => part.trim().length > 0)
            .join("\n\n");
          const text = body.length > 0 ? `${message.subject}\n\n${body}\n` : `${message.subject}\n`;
          yield* describe(
            input.root,
            "JjTurnService.describeLater",
            `change_id(${input.changeId})`,
            input.trailers ? withTrailers(text, input.threadId, input.ordinal) : text,
          );
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("jj seal description update failed", {
          changeId: input.changeId,
          cause,
        }),
      ),
    );

  const sealTurn: JjTurnService["Service"]["sealTurn"] = (input) =>
    Effect.gen(function* () {
      const root = yield* jjRoot(input.cwd);
      if (root === null) return;
      const trailers = yield* trailersEnabled(input.threadId);
      const title =
        (yield* projections.getThreadShell(input.threadId).pipe(Effect.orElseSucceed(() => null)))
          ?.title ?? "thread";
      const tag = (description: string) =>
        trailers ? withTrailers(description, input.threadId, input.ordinal) : description;
      const later = yield* withState(root, (initial) =>
        Effect.gen(function* () {
          let state = yield* pruneFinishedRuns(initial, input.runId);
          const run: ActiveRun = state.active[input.runId] ?? {
            runId: input.runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            startCommit: null,
          };
          state = yield* observe(root, {
            ...state,
            active: { ...state.active, [input.runId]: run },
          });

          // The agent's own commits: record them, tag the unpushed ones, and
          // flag files it took from another thread's turn.
          for (const change of yield* agentChanges(root, run, state)) {
            state = recordChange(state, change.changeId, input.threadId);
            const swept = change.files.filter((path) => {
              const owner = state.owners[path];
              return owner != null && owner.threadId !== input.threadId;
            });
            if (swept.length > 0) {
              state = addForeignPaths(
                addFlag(state, change.changeId, "swept"),
                change.changeId,
                swept,
              );
              state = {
                ...state,
                owners: Object.fromEntries(
                  Object.entries(state.owners).filter(([path]) => !swept.includes(path)),
                ),
              };
            }
            const tagged = trailerThreads(change.description).includes(input.threadId);
            if (
              trailers &&
              !tagged &&
              !change.pushed &&
              change.description.trim().length > 0 &&
              !(yield* otherWorkspacesBuildOn(root, change.changeId))
            ) {
              yield* describe(
                root,
                "JjTurnService.tagAgentChange",
                change.commitId,
                tag(change.description),
              );
            }
          }

          const changedPaths = yield* changedInWorkingCopy(root);
          const { paths, mixedPaths } = selectSealPaths(state, run, changedPaths);
          const before = yield* operationHead(root);
          let scheduled: DescribeLater | null = null;
          if (paths.length > 0) {
            const description = yield* readRevision(
              root,
              "JjTurnService.workingCopyDescription",
              "@",
              "description",
            );
            const sealedChangeId = yield* readRevision(
              root,
              "JjTurnService.workingCopyChange",
              "@",
              "change_id",
            );
            if (description.trim().length > 0 && paths.length === changedPaths.length) {
              // The agent named this change; keep its words and start the next one.
              if (trailers && !description.includes(`${JJ_THREAD_TRAILER}: ${input.threadId}`)) {
                yield* describe(root, "JjTurnService.tagWorkingCopy", "@", tag(description));
              }
              yield* jj.run({ operation: "JjTurnService.sealNew", root, args: ["new"] });
            } else {
              const provisional = tag(
                `wip: ${title} (turn ${input.ordinal})\n${
                  input.failed ? "\nTurn ended with an error.\n" : ""
                }`,
              );
              yield* jj.run({
                operation: "JjTurnService.seal",
                root,
                args: ["commit", "-m", provisional, "--", ...jjFilesets(paths)],
              });
              scheduled = {
                root,
                threadId: input.threadId,
                ordinal: input.ordinal,
                changeId: sealedChangeId,
                provisional,
                trailers,
                failed: input.failed,
              };
            }
            state = recordChange(state, sealedChangeId, input.threadId);
            if (mixedPaths.length > 0) {
              state = addForeignPaths(
                addFlag(state, sealedChangeId, "mixed"),
                sealedChangeId,
                mixedPaths,
              );
            }
            state = recordOperation(state, { before, after: yield* operationHead(root) });
          }
          const { [input.runId]: _ended, ...stillActive } = state.active;
          const next: WorkingCopyState = {
            ...state,
            active: stillActive,
            owners: pruneOwners(state.owners, yield* changedInWorkingCopy(root)),
            lastCommit: yield* workingCopyCommit(root),
          };
          return [scheduled, next] as const;
        }),
      );
      yield* notify;
      if (later !== null) yield* Effect.forkDetach(describeLater(later));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("jj seal failed; the turn's files stay in the working copy", {
          runId: input.runId,
          cause,
        }).pipe(Effect.andThen(notify)),
      ),
    );

  const awaitIdleSiblings = (input: { readonly threadId: ThreadId; readonly cwd: string }) =>
    Effect.gen(function* () {
      const root = yield* jjRoot(input.cwd);
      if (root === null) return;
      while (true) {
        const signal = yield* Ref.get(changed);
        const state = yield* jj.withWorkingCopyLock(
          root,
          Effect.flatMap(loadWorkingCopyState(io, root), (loaded) => pruneFinishedRuns(loaded)),
        );
        const busy = Object.values(state.active).some((run) => run.threadId !== input.threadId);
        if (!busy) return;
        yield* Deferred.await(signal);
      }
    }).pipe(
      Effect.timeoutOption(SIBLING_IDLE_TIMEOUT),
      Effect.flatMap((result) =>
        result._tag === "Some"
          ? Effect.void
          : Effect.fail(
              new JjTurnError({
                operation: "JjTurnService.awaitIdleSiblings",
                cwd: input.cwd,
                detail:
                  "Another thread kept a turn running in this checkout, so files were not reverted.",
              }),
            ),
      ),
    );

  /** Paths the changes touch, both sides of renames. */
  const filesOf = (root: string, changes: ReadonlyArray<{ readonly changeId: string }>) =>
    changes.length === 0
      ? Effect.succeed<ReadonlyArray<string>>([])
      : readRevision(
          root,
          "JjTurnService.filesOf",
          changes.map((change) => `change_id(${change.changeId})`).join(" | "),
          'json(diff.files().map(|f| f.path())) ++ "\\t" ++ json(diff.files().map(|f| f.source().path())) ++ "\\n"',
        ).pipe(
          Effect.flatMap((output) =>
            Effect.try(() =>
              output
                .split("\n")
                .filter((line) => line.length > 0)
                .flatMap((line) => line.split("\t").flatMap((list) => decodeJsonStrings(list))),
            ),
          ),
        );

  const prepareRevert: JjTurnService["Service"]["prepareRevert"] = (input) =>
    Effect.gen(function* () {
      const root = yield* jjRoot(input.cwd);
      if (root === null) return;
      const checkpoint = yield* readCheckpointCommit(io, root, input.checkpointRef);
      const known =
        checkpoint !== null &&
        (yield* jj
          .run({
            operation: "JjTurnService.prepareRevert",
            root,
            args: [
              "--ignore-working-copy",
              "log",
              "--no-graph",
              "-r",
              checkpoint,
              "-T",
              "commit_id",
            ],
            allowNonZeroExit: true,
          })
          .pipe(
            Effect.map((result) => result.exitCode === 0),
            Effect.orElseSucceed(() => false),
          ));
      if (!known) {
        return yield* new JjTurnError({
          operation: "JjTurnService.prepareRevert",
          cwd: input.cwd,
          detail:
            "jj has no record of this turn's files, for example because the turn ran before T3 Code used jj here. Rewind the conversation without restoring files instead.",
        });
      }
      yield* awaitIdleSiblings(input);
    });

  const listChanges = (root: string, revset: string) =>
    readRevision(
      root,
      "JjTurnService.revert.list",
      revset,
      'change_id ++ "\\t" ++ commit_id ++ "\\t" ++ empty ++ "\\n"',
    ).pipe(
      Effect.map((output) =>
        output
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => {
            const [changeId = "", commitId = "", empty = ""] = line.split("\t");
            return { changeId, commitId, empty: empty === "true" };
          }),
      ),
    );

  const revert: JjTurnService["Service"]["revert"] = (input) =>
    Effect.gen(function* () {
      const root = yield* jjRoot(input.cwd);
      if (root === null) {
        return yield* new JjTurnError({
          operation: "JjTurnService.revert",
          cwd: input.cwd,
          detail: "Not a jj working copy.",
        });
      }
      const checkpoint = yield* readCheckpointCommit(io, root, input.checkpointRef);
      if (checkpoint === null) {
        return yield* new JjTurnError({
          operation: "JjTurnService.revert",
          cwd: input.cwd,
          detail: "The checkpoint is no longer available in jj.",
        });
      }
      yield* withState(root, (initial) =>
        Effect.gen(function* () {
          const state = yield* observe(root, yield* pruneFinishedRuns(initial));
          const operationBefore = yield* operationHead(root);
          // Change ids, not commits: later rewrites (descriptions, rebases)
          // must not make earlier work look new. Whatever was sealed into the
          // checkpoint's own `@` since then is later work.
          const before = new Set(
            (yield* listChanges(root, `::${checkpoint} & mutable()`))
              .filter((change) => change.commitId !== checkpoint)
              .map((change) => change.changeId),
          );
          // Only changes known to be this thread's go: what T3 recorded for it
          // and what carries its trailer. Anything else is someone else's work.
          const stack = "(::@ & mutable()) ~ @";
          const tagged = new Set(
            (yield* listChanges(root, `(${stack}) & ${threadTrailerRevset(input.threadId)}`)).map(
              (change) => change.changeId,
            ),
          );
          const later = (yield* listChanges(root, stack)).filter(
            (change) =>
              !before.has(change.changeId) &&
              (state.changes[change.changeId] === input.threadId || tagged.has(change.changeId)),
          );
          // A change holding other threads' files, or one another workspace
          // builds on, stays; only this thread's paths in it go back below.
          const kept: Array<(typeof later)[number]> = [];
          const abandoned: Array<(typeof later)[number]> = [];
          for (const change of later) {
            const shared =
              state.foreignPaths[change.changeId] !== undefined ||
              (yield* otherWorkspacesBuildOn(root, change.changeId));
            (shared ? kept : abandoned).push(change);
          }
          if (abandoned.length > 0) {
            yield* jj.run({
              operation: "JjTurnService.revert.abandon",
              root,
              args: ["abandon", ...abandoned.map((change) => change.commitId)],
            });
          }
          // Restoring all of `@` is safe only when the stack below it is what
          // it was at the checkpoint and no other thread has files in `@`;
          // otherwise only this thread's paths go back, and never one that
          // other work after the checkpoint touched.
          const keptIds = new Set(kept.map((change) => change.changeId));
          const otherWork = (yield* listChanges(root, stack)).filter(
            (change) => !before.has(change.changeId) && !keptIds.has(change.changeId),
          );
          const otherThreadInvolved =
            kept.length > 0 ||
            otherWork.length > 0 ||
            Object.values(state.active).some((run) => run.threadId !== input.threadId) ||
            Object.values(state.owners).some(
              (owner) => owner === null || owner.threadId !== input.threadId,
            );
          const blocked = new Set([
            ...(yield* filesOf(root, otherWork)),
            ...kept.flatMap((change) => state.foreignPaths[change.changeId] ?? []),
            ...Object.entries(state.owners)
              .filter(([, owner]) => owner === null || owner.threadId !== input.threadId)
              .map(([path]) => path),
          ]);
          const own = [
            ...new Set([
              ...Object.entries(state.owners)
                .filter(([, owner]) => owner != null && owner.threadId === input.threadId)
                .map(([path]) => path),
              ...(yield* filesOf(root, kept)),
            ]),
          ].filter((path) => !blocked.has(path));
          if (!otherThreadInvolved) {
            yield* jj.run({
              operation: "JjTurnService.revert.restore",
              root,
              args: ["restore", "--from", checkpoint],
            });
          } else if (own.length > 0) {
            yield* jj.run({
              operation: "JjTurnService.revert.restore",
              root,
              args: ["restore", "--from", checkpoint, "--", ...jjFilesets(own)],
            });
          }
          const owners = Object.fromEntries(
            Object.entries(state.owners).filter(
              ([, owner]) => owner == null || owner.threadId !== input.threadId,
            ),
          );
          const next = recordOperation(
            {
              ...state,
              owners: pruneOwners(owners, yield* changedInWorkingCopy(root)),
              lastCommit: yield* workingCopyCommit(root),
            },
            { before: operationBefore, after: yield* operationHead(root) },
          );
          return [undefined, next] as const;
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new JjTurnError({
              operation: "JjTurnService.revert",
              cwd: input.cwd,
              detail: "Could not revert the thread's changes in jj.",
              cause,
            }),
        ),
      );
    });

  const assignPaths: JjTurnService["Service"]["assignPaths"] = (input) =>
    Effect.gen(function* () {
      const root = yield* jjRoot(input.cwd);
      if (root === null) {
        return yield* new JjActionError({
          action: "assignPaths",
          cwd: input.cwd,
          detail: "Not a jj working copy.",
        });
      }
      return yield* withState(root, (state) =>
        Effect.succeed([
          input.paths.length,
          {
            ...state,
            owners: {
              ...state.owners,
              ...Object.fromEntries(
                input.paths.map((path) => [
                  path,
                  {
                    runId: null,
                    threadId: input.threadId,
                    ordinal: 0,
                    source: "assigned" as const,
                  },
                ]),
              ),
            },
          },
        ] as const),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new JjActionError({
              action: "assignPaths",
              cwd: input.cwd,
              detail: "Could not record the assignment.",
              cause,
            }),
        ),
      );
    });

  const recordOperationFor: JjTurnService["Service"]["recordOperation"] = (root, operation) =>
    withState(root, (state) =>
      Effect.succeed([undefined, recordOperation(state, operation)] as const),
    ).pipe(
      Effect.catchCause((cause) => Effect.logWarning("could not record a jj operation", { cause })),
    );

  const forgetOperation: JjTurnService["Service"]["forgetOperation"] = (root, after) =>
    withState(root, (state) =>
      Effect.succeed([
        undefined,
        { ...state, operations: state.operations.filter((operation) => operation.after !== after) },
      ] as const),
    ).pipe(
      Effect.catchCause((cause) => Effect.logWarning("could not forget a jj operation", { cause })),
    );

  const rebaseline: JjTurnService["Service"]["rebaseline"] = (root) =>
    withState(root, (state) =>
      Effect.gen(function* () {
        const next: WorkingCopyState = {
          ...state,
          owners: pruneOwners(state.owners, yield* changedInWorkingCopy(root)),
          lastCommit: yield* workingCopyCommit(root),
        };
        return [undefined, next] as const;
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not rebaseline jj attribution", { cause }),
      ),
    );

  const forkBase: JjTurnService["Service"]["forkBase"] = (cwd) =>
    Effect.gen(function* () {
      const root = yield* jjRoot(cwd);
      if (root === null) return null;
      return yield* jj.withWorkingCopyLock(
        root,
        Effect.gen(function* () {
          yield* snapshotWorkingCopy(jj, root, "JjTurnService.forkBase");
          const [empty = "", parents = ""] = (yield* readRevision(
            root,
            "JjTurnService.forkBase",
            "@",
            'empty ++ "\\t" ++ parents.map(|c| c.commit_id()).join(",")',
          )).split("\t");
          const parentCommits = parents.split(",").filter((commit) => commit.length > 0);
          return empty === "true" && parentCommits.length === 1 ? parentCommits[0]! : null;
        }),
      );
    }).pipe(Effect.orElseSucceed(() => null));

  const mergeBack: JjTurnService["Service"]["mergeBack"] = (input) =>
    Effect.gen(function* () {
      const forkRoot = yield* jjRoot(input.forkCwd);
      const parentRoot = yield* jjRoot(input.parentCwd);
      if (forkRoot === null || parentRoot === null || forkRoot === parentRoot) return;
      const sameRepository =
        (yield* jj.repositoryDirectory(forkRoot)) === (yield* jj.repositoryDirectory(parentRoot));
      if (!sameRepository) return;
      const forkCommit = yield* jj.withWorkingCopyLock(
        forkRoot,
        snapshotWorkingCopy(jj, forkRoot, "JjTurnService.mergeBack.fork"),
      );
      yield* withState(parentRoot, (initial) =>
        Effect.gen(function* () {
          const state = yield* observe(parentRoot, yield* pruneFinishedRuns(initial));
          if (Object.keys(state.active).length > 0) {
            return yield* new JjTurnError({
              operation: "JjTurnService.mergeBack",
              cwd: input.parentCwd,
              detail:
                "A turn is running in the parent's working copy. Merge back when it finishes.",
            });
          }
          const parentCommit = yield* workingCopyCommit(parentRoot);
          const changes = yield* listChanges(
            parentRoot,
            `((::${forkCommit} ~ ::${parentCommit}) & mutable()) ~ (${forkCommit} & empty())`,
          );
          if (changes.length === 0) return [undefined, state] as const;
          const before = yield* operationHead(parentRoot);
          yield* jj.run({
            operation: "JjTurnService.mergeBack",
            root: parentRoot,
            args: [
              "rebase",
              ...changes.flatMap((change) => ["-r", change.commitId]),
              "--insert-after",
              "@-",
              "--insert-before",
              "@",
            ],
          });
          const next = recordOperation(
            {
              ...state,
              owners: pruneOwners(state.owners, yield* changedInWorkingCopy(parentRoot)),
              lastCommit: yield* workingCopyCommit(parentRoot),
            },
            { before, after: yield* operationHead(parentRoot) },
          );
          return [undefined, next] as const;
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "JjTurnError"
          ? cause
          : new JjTurnError({
              operation: "JjTurnService.mergeBack",
              cwd: input.parentCwd,
              detail: "Could not move the fork's changes into the parent.",
              cause,
            }),
      ),
    );

  return JjTurnService.of({
    turnStarted,
    sealTurn,
    isJjWorkingCopy,
    prepareRevert,
    revert,
    assignPaths,
    readState: (root) => loadWorkingCopyState(io, root),
    recordOperation: recordOperationFor,
    forgetOperation,
    rebaseline,
    forkBase,
    mergeBack,
  });
});

export const layer = Layer.effect(JjTurnService, make);
