/**
 * Finds a thread's jj work in every repository T3 knows on this environment:
 * project checkouts and thread workspaces. Trailers name the thread's changes;
 * operation tags show where its agent ran jj even before it committed.
 *
 * @module JjThreadWork
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  JJ_TURN_TRAILER,
  type JjThreadWorkChange,
  type JjThreadWorkRepository,
  type ThreadId,
} from "@t3tools/contracts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as JjCli from "../vcs/JjCli.ts";
import { findRepositoryMarker } from "../vcs/RepositoryMarker.ts";
import { operationUsername } from "./JjThreadLayer.ts";
import { decodeJsonBoolean, decodeJsonString, decodeJsonStrings } from "./jjTemplateJson.ts";
import { threadTrailerRevset } from "./JjTurnService.ts";

const MAX_CHANGES_PER_REPOSITORY = 50;
const RECENT_OPERATIONS = 500;

export class JjThreadWork extends Context.Service<
  JjThreadWork,
  {
    readonly find: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<JjThreadWorkRepository>>;
  }
>()("t3/jj/JjThreadWork") {}

const make = Effect.gen(function* () {
  const jj = yield* JjCli.JjCli;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;

  /** One jj workspace root per repository, from every project and thread directory. */
  const knownRepositories = Effect.gen(function* () {
    const projectRoots = (yield* projects.list()).map((project) => project.workspaceRoot);
    const [active, archived] = yield* Effect.all([
      threads.getShellSnapshot({ location: "active" }),
      threads.getShellSnapshot({ location: "archive" }),
    ]);
    const threadRoots = [...active.threads, ...archived.threads].flatMap((thread) =>
      thread.worktreePath === null ? [] : [thread.worktreePath],
    );
    const byRepository = new Map<string, string>();
    for (const candidate of new Set([...projectRoots, ...threadRoots])) {
      const marker = findRepositoryMarker(candidate);
      if (marker?.kind !== "jj") continue;
      const repository = yield* jj
        .repositoryDirectory(marker.root)
        .pipe(Effect.orElseSucceed(() => null));
      if (repository !== null && !byRepository.has(repository)) {
        byRepository.set(repository, marker.root);
      }
    }
    return [...byRepository.values()];
  });

  const changesIn = (root: string, threadId: ThreadId) =>
    jj
      .read({
        operation: "JjThreadWork.changes",
        root,
        args: [
          "--ignore-working-copy",
          "log",
          "--no-graph",
          "-n",
          String(MAX_CHANGES_PER_REPOSITORY),
          "-r",
          threadTrailerRevset(threadId),
          "-T",
          [
            "json(change_id)",
            "json(description.first_line())",
            `json(trailers.filter(|t| t.key() == "${JJ_TURN_TRAILER}").map(|t| t.value()))`,
            'json(self.contained_in("::remote_bookmarks()"))',
            "json(empty)",
          ].join(' ++ "\\t" ++ ') + ' ++ "\\n"',
        ],
      })
      .pipe(
        Effect.flatMap((output) =>
          Effect.try(() =>
            output
              .split("\n")
              .filter((line) => line.length > 0)
              .map((line): JjThreadWorkChange => {
                const [changeId = "", description = "", turns = "", pushed = "", empty = ""] =
                  line.split("\t");
                return {
                  changeId: decodeJsonString(changeId),
                  description: decodeJsonString(description),
                  turns: decodeJsonStrings(turns)
                    .map((turn) => Number.parseInt(turn, 10))
                    .filter((turn) => Number.isInteger(turn) && turn > 0),
                  pushed: decodeJsonBoolean(pushed),
                  empty: decodeJsonBoolean(empty),
                };
              }),
          ),
        ),
        Effect.orElseSucceed((): ReadonlyArray<JjThreadWorkChange> => []),
      );

  const taggedOperationsIn = (root: string, threadId: ThreadId) =>
    jj
      .read({
        operation: "JjThreadWork.operations",
        root,
        args: [
          "--ignore-working-copy",
          "op",
          "log",
          "--no-graph",
          "-n",
          String(RECENT_OPERATIONS),
          "-T",
          'user ++ "\\n"',
        ],
      })
      .pipe(
        Effect.map((output) => {
          const tag = operationUsername(threadId);
          return output
            .split("\n")
            .filter(
              (user) => user === tag || user.startsWith(`${tag}:`) || user.startsWith(`${tag}@`),
            ).length;
        }),
        Effect.orElseSucceed(() => 0),
      );

  const find: JjThreadWork["Service"]["find"] = (threadId) =>
    Effect.gen(function* () {
      const roots = yield* knownRepositories;
      const found = yield* Effect.forEach(
        roots,
        (root) =>
          Effect.all({
            changes: changesIn(root, threadId),
            taggedOperations: taggedOperationsIn(root, threadId),
          }).pipe(Effect.map((result) => ({ root, ...result }))),
        { concurrency: 4 },
      );
      return found.filter(
        (repository) => repository.changes.length > 0 || repository.taggedOperations > 0,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not search for the thread's jj work", { threadId, cause }).pipe(
          Effect.as([]),
        ),
      ),
    );

  return JjThreadWork.of({ find });
});

export const layer = Layer.effect(JjThreadWork, make);
