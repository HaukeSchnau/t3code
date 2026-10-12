/**
 * Reads the jj side of a working copy's status: the stack from `trunk()` to
 * `@`, conflicts, trailers and unattributed files. Every read passes
 * `--ignore-working-copy`, so polling never snapshots or races an agent's own
 * jj commands; status is as fresh as the last snapshot.
 *
 * @module JjStatusReader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  JJ_THREAD_TRAILER,
  JJ_TURN_TRAILER,
  type JjStackEntry,
  type JjStatus,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import { parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import * as JjCli from "../vcs/JjCli.ts";
import { splitNul } from "../vcs/JjVcsDriver.ts";
import { findRepositoryMarker } from "../vcs/RepositoryMarker.ts";
import { decodeJsonBoolean, decodeJsonString, decodeJsonStrings } from "./jjTemplateJson.ts";
import { loadWorkingCopyState } from "./JjWorkingCopyState.ts";

const MAX_STACK_ENTRIES = 100;

const STACK_TEMPLATE = [
  "json(change_id)",
  "json(commit_id)",
  "json(description.first_line())",
  "json(empty)",
  "json(conflict)",
  "json(current_working_copy)",
  "json(local_bookmarks.map(|b| b.name()))",
  'json(self.contained_in("::remote_bookmarks()"))',
  `json(trailers.filter(|t| t.key() == "${JJ_THREAD_TRAILER}").map(|t| t.value()))`,
  `json(trailers.filter(|t| t.key() == "${JJ_TURN_TRAILER}").map(|t| t.value()))`,
  'if(current_working_copy, json(conflicted_files.map(|e| e.path())), "[]")',
].join(' ++ "\\t" ++ ');

const TRUNK_TEMPLATE = [
  "json(change_id)",
  "json(root)",
  // json() cannot serialize concatenated names, so they are joined with NUL.
  'remote_bookmarks.filter(|b| b.remote() != "git").map(|b| b.name() ++ "@" ++ b.remote()).join("\\0")',
  "json(local_bookmarks.map(|b| b.name()))",
].join(' ++ "\\t" ++ ');

interface ParsedStackLine {
  readonly entry: Omit<JjStackEntry, "flags">;
  readonly conflictedFiles: ReadonlyArray<string>;
}

function parseStackLine(line: string): ParsedStackLine {
  const [
    changeId = "",
    commitId = "",
    description = "",
    empty = "",
    conflict = "",
    workingCopy = "",
    bookmarks = "",
    pushed = "",
    threads = "",
    turns = "",
    conflictedFiles = "",
  ] = line.split("\t");
  return {
    entry: {
      changeId: decodeJsonString(changeId),
      commitId: decodeJsonString(commitId),
      description: decodeJsonString(description),
      empty: decodeJsonBoolean(empty),
      conflict: decodeJsonBoolean(conflict),
      workingCopy: decodeJsonBoolean(workingCopy),
      bookmarks: decodeJsonStrings(bookmarks),
      pushed: decodeJsonBoolean(pushed),
      threadId: decodeJsonStrings(threads)[0] ?? null,
      turns: decodeJsonStrings(turns)
        .map((turn) => Number.parseInt(turn, 10))
        .filter((turn) => Number.isInteger(turn) && turn > 0),
    },
    conflictedFiles: decodeJsonStrings(conflictedFiles),
  };
}

export class JjStatusReader extends Context.Service<
  JjStatusReader,
  {
    /**
     * Local status for `cwd`. In a jj working copy it adds the jj block to the
     * Git status, or builds the status from jj alone when there is no Git
     * worktree. Elsewhere it returns the Git status, marked as Git.
     */
    readonly localStatus: <E>(
      cwd: string,
      gitStatus: Effect.Effect<VcsStatusLocalResult, E>,
    ) => Effect.Effect<VcsStatusLocalResult, E>;
    /** True for a jj working copy without a Git worktree, where Git status fails. */
    readonly isJjWithoutGit: (cwd: string) => Effect.Effect<boolean>;
    readonly read: (cwd: string) => Effect.Effect<JjStatus | null>;
  }
>()("t3/jj/JjStatusReader") {}

const make = Effect.gen(function* () {
  const jj = yield* JjCli.JjCli;
  const io = { fileSystem: yield* FileSystem.FileSystem, path: yield* Path.Path };

  const jjRoot = (cwd: string) =>
    Effect.gen(function* () {
      const marker = findRepositoryMarker(cwd);
      if (marker?.kind !== "jj" || !(yield* jj.supported)) return null;
      return marker;
    });

  const read: JjStatusReader["Service"]["read"] = (cwd) =>
    Effect.gen(function* () {
      const marker = yield* jjRoot(cwd);
      if (marker === null) return null;
      const root = marker.root;
      const query = (operation: string, args: ReadonlyArray<string>) =>
        jj.read({ operation, root, args: ["--ignore-working-copy", ...args] });
      const [operationId, stackOutput, trunkOutput, changedOutput, state] = yield* Effect.all(
        [
          query("JjStatusReader.operation", ["op", "log", "-n", "1", "--no-graph", "-T", "id"]),
          query("JjStatusReader.stack", [
            "log",
            "--no-graph",
            "-n",
            String(MAX_STACK_ENTRIES),
            "-r",
            "trunk()..@",
            "-T",
            `${STACK_TEMPLATE} ++ "\\n"`,
          ]),
          query("JjStatusReader.trunk", [
            "log",
            "--no-graph",
            "-r",
            "trunk()",
            "-T",
            TRUNK_TEMPLATE,
          ]),
          query("JjStatusReader.changed", ["diff", "-r", "@", "-T", 'path ++ "\\0"']),
          loadWorkingCopyState(io, root),
        ],
        { concurrency: "unbounded" },
      );
      const { parsed, trunk } = yield* Effect.try(() => {
        const [change = "", isRoot = "", remote = "", local = ""] = trunkOutput.split("\t");
        return {
          parsed: stackOutput
            .split("\n")
            .filter((line) => line.length > 0)
            .map(parseStackLine),
          trunk: {
            change: decodeJsonString(change),
            isRoot: decodeJsonBoolean(isRoot),
            remote: remote.split("\0").filter((label) => label.length > 0),
            local: decodeJsonStrings(local),
          },
        };
      });
      const changed = new Set(splitNul(changedOutput));
      return {
        operationId,
        trunk: trunk.isRoot
          ? null
          : {
              changeId: trunk.change,
              label: trunk.remote[0] ?? trunk.local[0] ?? trunk.change.slice(0, 8),
            },
        stack: parsed.map(({ entry }) => ({ ...entry, flags: state.flags[entry.changeId] ?? [] })),
        conflictedFiles: parsed.flatMap((line) => line.conflictedFiles),
        unattributed: Object.entries(state.owners)
          .filter(([path, owner]) => owner === null && changed.has(path))
          .map(([path]) => path)
          .toSorted(),
      } satisfies JjStatus;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not read jj status", { cwd, cause }).pipe(Effect.as(null)),
      ),
    );

  /** Status for a jj working copy that has no Git worktree. */
  const jjOnlyLocal = (root: string, status: JjStatus) =>
    Effect.gen(function* () {
      const workingCopy = status.stack.find((entry) => entry.workingCopy);
      const parent = yield* jj
        .read({
          operation: "JjStatusReader.parent",
          root,
          args: [
            "--ignore-working-copy",
            "log",
            "--no-graph",
            "-r",
            "@-",
            "-T",
            'commit_id ++ "\\n"',
          ],
        })
        .pipe(Effect.map((output) => output.split("\n")[0]?.trim() ?? ""));
      const numstat =
        workingCopy === undefined || workingCopy.empty || parent.length === 0
          ? ""
          : (yield* jj.git({
              operation: "JjStatusReader.numstat",
              root,
              args: ["diff", "--numstat", "-z", parent, workingCopy.commitId],
              allowNonZeroExit: true,
            })).stdout;
      const files = parseTurnDiffFilesFromNumstat(numstat).map((file) => ({
        path: file.path,
        insertions: file.additions,
        deletions: file.deletions,
      }));
      const remotes = yield* jj
        .read({
          operation: "JjStatusReader.remotes",
          root,
          args: ["--ignore-working-copy", "git", "remote", "list"],
        })
        .pipe(Effect.orElseSucceed(() => ""));
      return {
        isRepo: true,
        hasPrimaryRemote: remotes.split("\n").some((line) => line.split(/\s+/)[0] === "origin"),
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: files.length > 0,
        workingTree: {
          files,
          insertions: files.reduce((sum, file) => sum + file.insertions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
        },
      } satisfies VcsStatusLocalResult;
    });

  const localStatus: JjStatusReader["Service"]["localStatus"] = (cwd, gitStatus) =>
    Effect.gen(function* () {
      const marker = yield* jjRoot(cwd);
      if (marker === null) {
        const local = yield* gitStatus;
        return local.isRepo ? { ...local, kind: "git" as const } : local;
      }
      const status = yield* read(cwd);
      if (marker.colocated) {
        const local = yield* gitStatus;
        return { ...local, kind: "jj" as const, ...(status === null ? {} : { jj: status }) };
      }
      if (status === null) return yield* gitStatus;
      const local = yield* jjOnlyLocal(marker.root, status).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("could not build jj status", { cwd, cause }).pipe(
            Effect.andThen(gitStatus),
          ),
        ),
      );
      return { ...local, kind: "jj" as const, jj: status };
    });

  const isJjWithoutGit: JjStatusReader["Service"]["isJjWithoutGit"] = (cwd) =>
    Effect.map(jjRoot(cwd), (marker) => marker !== null && !marker.colocated);

  return JjStatusReader.of({ localStatus, isJjWithoutGit, read });
});

export const layer = Layer.effect(JjStatusReader, make);
