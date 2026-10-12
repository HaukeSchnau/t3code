/**
 * The jj actions users and agents run from T3: describe, commit, new, squash,
 * abandon, split, absorb, edit, bookmark, push, pull request, fetch, rebase
 * and undo. Actions that rewrite files on disk wait for no turn to be running
 * in the working copy, because jj overwrites files without checking for an
 * agent's unsnapshotted edits.
 *
 * @module JjWorkflow
 */
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  JjActionError,
  type JjAction,
  type JjRunActionInput,
  type JjRunActionResult,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as JjCli from "../vcs/JjCli.ts";
import { jjFilesets } from "../vcs/JjVcsDriver.ts";
import { findRepositoryMarker } from "../vcs/RepositoryMarker.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as JjCommitWriter from "./JjCommitWriter.ts";
import { decodeJsonString, decodeJsonStrings } from "./jjTemplateJson.ts";
import * as JjTurnService from "./JjTurnService.ts";

export class JjWorkflow extends Context.Service<
  JjWorkflow,
  {
    readonly runAction: (
      input: JjRunActionInput,
    ) => Effect.Effect<JjRunActionResult, JjActionError>;
  }
>()("t3/jj/JjWorkflow") {}

const isJjActionError = Schema.is(JjActionError);

/** Actions that can change files on disk and so must not run under an agent. */
const REWRITES_FILES: ReadonlySet<JjAction["_tag"]> = new Set([
  "new",
  "edit",
  "abandon",
  "rebase",
  "undo",
]);

const T3_TRAILER_LINE = /^T3-(Thread|Turn): /;

/** Removes T3 trailer lines, and the blank line before them when nothing else remains. */
export function stripT3Trailers(description: string): string {
  const lines = description.replace(/\s+$/, "").split("\n");
  const kept = lines.filter((line) => !T3_TRAILER_LINE.test(line));
  while (kept.length > 0 && kept.at(-1)?.trim() === "") kept.pop();
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

/** Combines a squashed change's message into its parent's, keeping one trailer block. */
export function mergeDescriptions(destination: string, source: string): string {
  const split = (text: string) => {
    const lines = text.replace(/\s+$/, "").split("\n");
    return {
      body: stripT3Trailers(text).trim(),
      trailers: lines.filter((line) => T3_TRAILER_LINE.test(line)),
    };
  };
  const into = split(destination);
  const from = split(source);
  const bodies = [into.body, from.body].filter(
    (body, index, all) => body.length > 0 && all.indexOf(body) === index,
  );
  const trailers = [...new Set([...into.trailers, ...from.trailers])];
  const text = [bodies.join("\n\n"), trailers.join("\n")].filter((part) => part.length > 0);
  return text.length === 0 ? "" : `${text.join("\n\n")}\n`;
}

export function bookmarkSlug(description: string, changeId: string): string {
  const slug = description
    .split("\n")[0]!
    .toLowerCase()
    .replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `t3code/${slug.length > 0 ? slug : changeId.slice(0, 8)}`;
}

const make = Effect.gen(function* () {
  const jj = yield* JjCli.JjCli;
  const turns = yield* JjTurnService.JjTurnService;
  const writer = yield* JjCommitWriter.JjCommitWriter;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runAction: JjWorkflow["Service"]["runAction"] = (input) =>
    Effect.gen(function* () {
      const action = input.action;
      const fail = (detail: string, cause?: unknown) =>
        new JjActionError({
          action: action._tag,
          cwd: input.cwd,
          detail,
          ...(cause === undefined ? {} : { cause }),
        });
      const marker = findRepositoryMarker(input.cwd);
      if (marker?.kind !== "jj" || !(yield* jj.supported)) {
        return yield* fail("This folder is not a jj working copy, or jj is older than 0.46.");
      }
      const root = marker.root;
      const run = (args: ReadonlyArray<string>) =>
        jj
          .run({ operation: `JjWorkflow.${action._tag}`, root, args })
          .pipe(Effect.mapError((cause) => fail(cause.message, cause)));
      const read = (args: ReadonlyArray<string>) =>
        jj
          .read({
            operation: `JjWorkflow.${action._tag}.read`,
            root,
            args: ["--ignore-working-copy", ...args],
          })
          .pipe(Effect.mapError((cause) => fail(cause.message, cause)));
      const revision = (changeId: string) => `change_id(${changeId})`;
      const describeOf = (rev: string) =>
        read(["log", "--no-graph", "-r", rev, "-T", "description"]);

      const projectSettings = Effect.gen(function* () {
        const settings = yield* settingsService.getSettings;
        const projectId: ProjectId | null =
          input.threadId !== undefined
            ? ((yield* threads
                .getThreadShell(input.threadId)
                .pipe(Effect.orElseSucceed(() => null)))?.projectId ?? null)
            : (Option.getOrNull(
                yield* projects
                  .findActiveByWorkspaceRoot(root)
                  .pipe(Effect.orElseSucceed(() => Option.none())),
              )?.projectId ?? null);
        return resolveProjectSettings(settings, projectId).settings;
      }).pipe(Effect.mapError((cause) => fail("Could not read settings.", cause)));

      const generatedMessage = (rev: string) =>
        writer
          .commitMessage({ root, threadId: input.threadId as ThreadId | undefined, revision: rev })
          .pipe(
            Effect.flatMap((message) =>
              message === null
                ? Effect.fail(
                    fail("The commit writer could not describe this change. Enter a message."),
                  )
                : Effect.succeed(
                    message.body.length > 0
                      ? `${message.subject}\n\n${message.body}\n`
                      : `${message.subject}\n`,
                  ),
            ),
          );

      let summary = "";
      let pullRequestUrl: string | undefined;
      // Recorded after the lock is released; the turn service takes it too.
      let undone: string | undefined;

      const execute = Effect.gen(function* () {
        switch (action._tag) {
          case "describe": {
            const current = yield* describeOf(revision(action.changeId));
            const trailerBlock = current.split("\n").filter((line) => T3_TRAILER_LINE.test(line));
            const body =
              action.message !== undefined && action.message.trim().length > 0
                ? `${action.message.trim()}\n`
                : yield* generatedMessage(revision(action.changeId));
            const message =
              trailerBlock.length > 0 ? `${body.trimEnd()}\n\n${trailerBlock.join("\n")}\n` : body;
            yield* run(["describe", "-r", revision(action.changeId), "-m", message]);
            summary = `Described ${action.changeId.slice(0, 8)}`;
            return;
          }
          case "commit": {
            const message =
              action.message !== undefined && action.message.trim().length > 0
                ? `${action.message.trim()}\n`
                : yield* generatedMessage("@");
            yield* run([
              "commit",
              "-m",
              message,
              ...(action.paths !== undefined && action.paths.length > 0
                ? ["--", ...jjFilesets(action.paths)]
                : []),
            ]);
            summary = `Committed: ${message.split("\n")[0]}`;
            return;
          }
          case "new": {
            yield* run(action.base === undefined ? ["new"] : ["new", action.base]);
            summary = "Started a new change";
            return;
          }
          case "squash": {
            const source = yield* describeOf(revision(action.changeId));
            const destination = yield* describeOf(`${revision(action.changeId)}-`);
            const message = mergeDescriptions(destination, source);
            yield* run([
              "squash",
              "-r",
              revision(action.changeId),
              ...(message.length > 0 ? ["-m", message] : ["--use-destination-message"]),
            ]);
            summary = `Squashed ${action.changeId.slice(0, 8)} into its parent`;
            return;
          }
          case "abandon": {
            yield* run(["abandon", revision(action.changeId)]);
            summary = `Abandoned ${action.changeId.slice(0, 8)}`;
            return;
          }
          case "split": {
            if (action.paths.length === 0)
              return yield* fail("Choose the files for the first part.");
            const message =
              action.message !== undefined && action.message.trim().length > 0
                ? `${action.message.trim()}\n`
                : (yield* describeOf(revision(action.changeId))) || "Split part\n";
            yield* run([
              "split",
              "-r",
              revision(action.changeId),
              "-m",
              message,
              "--",
              ...jjFilesets(action.paths),
            ]);
            summary = `Split ${action.changeId.slice(0, 8)}`;
            return;
          }
          case "absorb": {
            yield* run(["absorb"]);
            summary = "Absorbed changes into the stack";
            return;
          }
          case "edit": {
            yield* run(["edit", revision(action.changeId)]);
            summary = `Editing ${action.changeId.slice(0, 8)}`;
            return;
          }
          case "bookmark": {
            switch (action.operation) {
              case "set":
                yield* run([
                  "bookmark",
                  "set",
                  action.name,
                  "--allow-backwards",
                  "-r",
                  action.changeId === undefined ? "@-" : revision(action.changeId),
                ]);
                summary = `Set bookmark ${action.name}`;
                return;
              case "rename":
                if (action.newName === undefined)
                  return yield* fail("Enter the new bookmark name.");
                yield* run(["bookmark", "rename", action.name, action.newName]);
                summary = `Renamed ${action.name} to ${action.newName}`;
                return;
              case "delete":
                yield* run(["bookmark", "delete", action.name]);
                summary = `Deleted bookmark ${action.name}`;
                return;
            }
            return;
          }
          case "push":
          case "pr": {
            const pushed = yield* push(action.changeId);
            if (action._tag === "push") {
              summary = `Pushed ${pushed.bookmark}`;
              return;
            }
            pullRequestUrl = yield* openPullRequest(pushed);
            summary = `Opened a pull request for ${pushed.bookmark}`;
            return;
          }
          case "fetch": {
            yield* run(["git", "fetch"]);
            summary = "Fetched";
            return;
          }
          case "rebase": {
            yield* run(["rebase", "-s", "roots(trunk()..@)", "-o", "trunk()"]);
            summary = "Rebased the stack onto trunk";
            return;
          }
          case "undo": {
            const state = yield* turns.readState(root);
            const target =
              action.operationId === undefined
                ? state.operations.at(-1)
                : state.operations.find((operation) => operation.after === action.operationId);
            if (target === undefined) return yield* fail("There is no T3 operation to undo here.");
            // Revert every operation the action recorded, newest first, so later
            // work by agents or other threads stays.
            const recent = (yield* read([
              "op",
              "log",
              "--no-graph",
              "-n",
              "500",
              "-T",
              'id ++ "\\n"',
            ]))
              .split("\n")
              .filter((line) => line.length > 0);
            const afterIndex = recent.indexOf(target.after);
            const beforeIndex = recent.indexOf(target.before);
            if (afterIndex === -1 || beforeIndex === -1 || beforeIndex <= afterIndex) {
              return yield* fail("That operation is no longer in jj's operation log.");
            }
            for (const operation of recent.slice(afterIndex, beforeIndex)) {
              yield* run(["op", "revert", operation]);
            }
            undone = target.after;
            summary = "Undid the last T3 operation";
            return;
          }
        }
      });

      /** Pushes a change under its bookmark, creating `t3code/<slug>` when it has none. */
      const push = (changeId: string | undefined) =>
        Effect.gen(function* () {
          const target =
            changeId !== undefined
              ? revision(changeId)
              : (yield* read(["log", "--no-graph", "-r", "@", "-T", "empty"])) === "true"
                ? "@-"
                : "@";
          const [resolvedChange = "", description = "", bookmarksJson = "[]"] = (yield* read([
            "log",
            "--no-graph",
            "-r",
            target,
            "-T",
            'change_id ++ "\\t" ++ json(description) ++ "\\t" ++ json(local_bookmarks.map(|b| b.name()))',
          ])).split("\t");
          const bookmarks = yield* Effect.try(() => decodeJsonStrings(bookmarksJson)).pipe(
            Effect.mapError((cause) => fail("Could not read the change's bookmarks.", cause)),
          );
          const settings = yield* projectSettings;
          const remote = "origin";
          if (settings.jjStripTrailersRemotes.includes(remote)) {
            const tagged = (yield* read([
              "log",
              "--no-graph",
              "-r",
              `(trunk()..${target}) & description(regex:"(?m)^T3-(Thread|Turn): ")`,
              "-T",
              'change_id ++ "\\n"',
            ]))
              .split("\n")
              .filter((line) => line.length > 0);
            for (const tag of tagged) {
              yield* run([
                "describe",
                "-r",
                revision(tag),
                "-m",
                stripT3Trailers(yield* describeOf(revision(tag))),
              ]);
            }
          }
          if (bookmarks.length > 0) {
            yield* run(["git", "push", "--remote", remote, "-b", bookmarks[0]!]);
            return { bookmark: bookmarks[0]!, changeId: resolvedChange, target };
          }
          const existing = new Set(
            (yield* read(["bookmark", "list", "-T", 'name ++ "\\n"']))
              .split("\n")
              .filter((line) => line.length > 0),
          );
          const base = bookmarkSlug(
            yield* Effect.try(() => decodeJsonString(description)).pipe(
              Effect.mapError((cause) => fail("Could not read the change's description.", cause)),
            ),
            resolvedChange,
          );
          let name = base;
          for (let suffix = 2; existing.has(name); suffix += 1) name = `${base}-${suffix}`;
          yield* run([
            "git",
            "push",
            "--remote",
            remote,
            "--named",
            `${name}=${revision(resolvedChange)}`,
          ]);
          return { bookmark: name, changeId: resolvedChange, target };
        });

      const openPullRequest = (pushed: { readonly bookmark: string; readonly changeId: string }) =>
        Effect.gen(function* () {
          const handle = yield* sourceControl
            .resolveHandle({ cwd: root })
            .pipe(
              Effect.mapError((cause) =>
                fail("No source control provider for this repository.", cause),
              ),
            );
          const [trunkBookmarksJson = "[]"] = (yield* read([
            "log",
            "--no-graph",
            "-r",
            "trunk()",
            "-T",
            "json(local_bookmarks.map(|b| b.name()))",
          ])).split("\t");
          const baseBranch =
            (yield* Effect.try(() => decodeJsonStrings(trunkBookmarksJson)).pipe(
              Effect.orElseSucceed((): ReadonlyArray<string> => []),
            ))[0] ??
            (yield* handle.provider
              .getDefaultBranch({
                cwd: root,
                ...(handle.context === null ? {} : { context: handle.context }),
              })
              .pipe(Effect.orElseSucceed(() => null))) ??
            "main";
          const revset = `trunk()..${revision(pushed.changeId)}`;
          const generated = yield* writer.pullRequest({
            root,
            threadId: input.threadId as ThreadId | undefined,
            revset,
            baseBranch,
            headBranch: pushed.bookmark,
          });
          const subjects = (yield* read([
            "log",
            "--no-graph",
            "-r",
            revset,
            "-T",
            'description.first_line() ++ "\\n"',
          ]))
            .split("\n")
            .filter((line) => line.length > 0);
          const title = generated?.title ?? subjects.at(-1) ?? pushed.bookmark;
          const body =
            generated?.body ??
            subjects
              .toReversed()
              .map((subject) => `- ${subject}`)
              .join("\n");
          const bodyFile = path.join(
            yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-jj-pr-" }),
            `${NodeCrypto.randomUUID()}.md`,
          );
          yield* fileSystem.writeFileString(bodyFile, body);
          yield* handle.provider
            .createChangeRequest({
              cwd: root,
              ...(handle.context === null ? {} : { context: handle.context }),
              baseRefName: baseBranch,
              headSelector: pushed.bookmark,
              title,
              bodyFile,
            })
            .pipe(Effect.mapError((cause) => fail(cause.message, cause)));
          const created = yield* handle.provider
            .listChangeRequests({
              cwd: root,
              ...(handle.context === null ? {} : { context: handle.context }),
              headSelector: pushed.bookmark,
              state: "open",
              limit: 1,
            })
            .pipe(Effect.orElseSucceed(() => []));
          return created[0]?.url;
        }).pipe(
          Effect.scoped,
          Effect.mapError((cause) =>
            isJjActionError(cause) ? cause : fail("Could not open the pull request.", cause),
          ),
        );

      const operationHead = read(["op", "log", "-n", "1", "--no-graph", "-T", "id"]);
      // Under the lock no turn can start or seal, so the turn check holds and
      // the recorded group holds only the action. Snapshotting first means
      // undo never discards edits made since the last snapshot.
      const [before, operationId] = yield* jj.withWorkingCopyLock(
        root,
        Effect.gen(function* () {
          if (REWRITES_FILES.has(action._tag)) {
            const state = yield* turns.readState(root);
            if (Object.keys(state.active).length > 0) {
              return yield* fail(
                "A turn is running in this working copy. Try again when it finishes.",
              );
            }
          }
          yield* jj
            .run({ operation: "JjWorkflow.snapshot", root, args: ["util", "snapshot"] })
            .pipe(Effect.mapError((cause) => fail(cause.message, cause)));
          const head = yield* operationHead;
          yield* execute;
          return [head, yield* operationHead.pipe(Effect.orElseSucceed(() => null))] as const;
        }),
      );
      if (undone !== undefined) yield* turns.forgetOperation(root, undone);
      if (operationId !== null && action._tag !== "undo") {
        yield* turns.recordOperation(root, { before, after: operationId });
      }
      yield* turns.rebaseline(root);
      const conflictedChanges = (yield* read([
        "log",
        "--no-graph",
        "-r",
        "(trunk()..@) & conflicts()",
        "-T",
        'change_id ++ "\\n"',
      ]).pipe(Effect.orElseSucceed(() => "")))
        .split("\n")
        .filter((line) => line.length > 0);
      yield* vcsStatus.refreshStatus(input.cwd).pipe(Effect.ignore, Effect.forkDetach);
      return {
        operationId,
        summary,
        conflictedChanges,
        ...(pullRequestUrl === undefined ? {} : { pullRequestUrl }),
      } satisfies JjRunActionResult;
    });

  return JjWorkflow.of({ runAction });
});

export const layer = Layer.effect(JjWorkflow, make);
