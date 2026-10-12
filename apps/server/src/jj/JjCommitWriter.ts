/**
 * Writes commit and pull request text for jj changes with the source control
 * writer the user configured, following the same writing style as Git commits.
 *
 * @module JjCommitWriter
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { limitContext, sanitizeCommitMessage } from "../textGeneration/commitMessageText.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  conventionalCommitsTextGenerationPolicy,
  customTextGenerationPolicy,
  repositoryConventionsTextGenerationPolicy,
} from "../textGeneration/TextGenerationPresets.ts";
import * as JjCli from "../vcs/JjCli.ts";

export interface JjWriterTarget {
  /** Workspace root of the jj working copy. */
  readonly root: string;
  readonly threadId?: ThreadId | string | undefined;
}

export class JjCommitWriter extends Context.Service<
  JjCommitWriter,
  {
    /** A message for one change, or null when the writer fails. */
    readonly commitMessage: (
      input: JjWriterTarget & { readonly revision: string },
    ) => Effect.Effect<{ readonly subject: string; readonly body: string } | null>;
    /** Title and body for a pull request over `revset`, or null when the writer fails. */
    readonly pullRequest: (
      input: JjWriterTarget & {
        readonly revset: string;
        readonly baseBranch: string;
        readonly headBranch: string;
      },
    ) => Effect.Effect<{ readonly title: string; readonly body: string } | null>;
  }
>()("t3/jj/JjCommitWriter") {}

const make = Effect.gen(function* () {
  const jj = yield* JjCli.JjCli;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const writerSettings = Effect.fn("JjCommitWriter.settings")(function* (target: JjWriterTarget) {
    const settings = yield* settingsService.getSettings;
    const projectId: ProjectId | null =
      target.threadId !== undefined
        ? yield* threads.getThreadShell(target.threadId as ThreadId).pipe(
            Effect.map((thread) => thread?.projectId ?? null),
            Effect.orElseSucceed(() => null),
          )
        : yield* projects.findActiveByWorkspaceRoot(target.root).pipe(
            Effect.map((project) => Option.getOrNull(project)?.projectId ?? null),
            Effect.orElseSucceed(() => null),
          );
    const resolved = resolveProjectSettings(settings, projectId).settings;
    const modelSelection =
      resolved.sourceControlWriterModelSelection === null
        ? resolved.textGenerationModelSelection
        : ServerSettings.resolveSourceControlWriterModelSelection(
            resolved,
            yield* providers.getProviders,
          );
    return { modelSelection, style: resolved.sourceControlWritingStyle };
  });

  const readInstructions = (root: string, fileName: string) =>
    fileSystem.readFileString(path.join(root, fileName)).pipe(
      Effect.map((contents) => (contents.length > 20_000 ? "" : contents.trim())),
      Effect.orElseSucceed(() => ""),
    );

  const policyFor = Effect.fn("JjCommitWriter.policy")(function* (
    root: string,
    style: Effect.Success<ReturnType<typeof writerSettings>>["style"],
  ) {
    switch (style.mode) {
      case "conventional_commits":
        return conventionalCommitsTextGenerationPolicy;
      case "custom":
        return customTextGenerationPolicy(
          style.customInstructions
            ? {
                commitInstructions: style.customInstructions,
                changeRequestInstructions: style.customInstructions,
              }
            : {},
        );
      case "repo_conventions": {
        const subjects = (yield* jj
          .read({
            operation: "JjCommitWriter.recentSubjects",
            root,
            args: [
              "--ignore-working-copy",
              "log",
              "--no-graph",
              "-n",
              "20",
              "-r",
              "::@- ~ empty() ~ merges()",
              "-T",
              'description.first_line() ++ "\\n"',
            ],
          })
          .pipe(Effect.orElseSucceed(() => "")))
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        const agents = yield* readInstructions(root, "AGENTS.md");
        const examples = [
          ...(subjects.length > 0
            ? [["Recent commit subjects from this repository:", ...subjects].join("\n")]
            : []),
          ...(agents ? [`Local AGENTS.md:\n${agents}`] : []),
        ].join("\n\n");
        if (!examples) return repositoryConventionsTextGenerationPolicy;
        return {
          ...repositoryConventionsTextGenerationPolicy,
          commitInstructions: `${repositoryConventionsTextGenerationPolicy.commitInstructions}\n\n${examples}`,
          changeRequestInstructions: `${repositoryConventionsTextGenerationPolicy.changeRequestInstructions}\n\n${examples}`,
        };
      }
    }
  });

  const diffContext = (root: string, revisionArgs: ReadonlyArray<string>) =>
    Effect.all({
      summary: jj.read({
        operation: "JjCommitWriter.diffSummary",
        root,
        args: [
          "--ignore-working-copy",
          "diff",
          ...revisionArgs,
          "-T",
          'status_char ++ " " ++ path ++ "\\n"',
        ],
      }),
      patch: jj.read({
        operation: "JjCommitWriter.diffPatch",
        root,
        args: ["--ignore-working-copy", "diff", "--git", ...revisionArgs],
        maxOutputBytes: 2_000_000,
      }),
    });

  const commitMessage: JjCommitWriter["Service"]["commitMessage"] = (input) =>
    Effect.gen(function* () {
      const context = yield* diffContext(input.root, ["-r", input.revision]);
      if (context.summary.length === 0) return null;
      const settings = yield* writerSettings(input);
      const policy = yield* policyFor(input.root, settings.style);
      const generated = yield* textGeneration.generateCommitMessage({
        cwd: input.root,
        branch: null,
        stagedSummary: limitContext(context.summary, 8_000),
        stagedPatch: limitContext(context.patch, 50_000),
        policy,
        modelSelection: settings.modelSelection,
      });
      const { subject, body } = sanitizeCommitMessage(generated);
      return { subject, body };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("jj commit message generation failed", { cause }).pipe(Effect.as(null)),
      ),
    );

  const pullRequest: JjCommitWriter["Service"]["pullRequest"] = (input) =>
    Effect.gen(function* () {
      const commits = yield* jj.read({
        operation: "JjCommitWriter.prCommits",
        root: input.root,
        args: [
          "--ignore-working-copy",
          "log",
          "--no-graph",
          "-r",
          input.revset,
          "-T",
          'description.first_line() ++ "\\n"',
        ],
      });
      const context = yield* diffContext(input.root, [
        "--from",
        `heads(::(${input.revset}) & ::trunk())`,
        "--to",
        `heads(${input.revset})`,
      ]);
      const settings = yield* writerSettings(input);
      const policy = yield* policyFor(input.root, settings.style);
      const generated = yield* textGeneration.generatePrContent({
        cwd: input.root,
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: limitContext(commits, 20_000),
        diffSummary: limitContext(context.summary, 20_000),
        diffPatch: limitContext(context.patch, 60_000),
        policy,
        modelSelection: settings.modelSelection,
      });
      return { title: generated.title, body: generated.body };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("jj pull request text generation failed", { cause }).pipe(
          Effect.as(null),
        ),
      ),
    );

  return JjCommitWriter.of({ commitMessage, pullRequest });
});

export const layer = Layer.effect(JjCommitWriter, make);
