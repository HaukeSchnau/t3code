#!/usr/bin/env node
// Publishes a signed macOS build to the fork's desktop update feed
// (patches/desktop-distribution.md). The CI workflow runs it on srv-2 after the
// Apple builder packaged the app and CI passed.
//
// Layout under --updates-dir, which the update host serves as /desktop/:
//   latest-mac.yml               electron-updater's feed, replaced last
//   T3-Code-<version>-arm64.zip  plus its .blockmap, the newest few builds
//   install.sh, index.html       first install and a human-readable status page
//   published.json               version and commit of the current build

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";

class DesktopPublishError extends Schema.TaggedError<DesktopPublishError>()("DesktopPublishError", {
  message: Schema.String,
}) {}

/** Builds kept for manual installs. Differential updates only need the newest one. */
const KEPT_BUILDS = 3;
const MAX_RELEASE_NOTES = 20;

const PublishedBuild = Schema.Struct({ version: Schema.String, commit: Schema.String });
const PublishedBuildJson = Schema.fromJsonString(PublishedBuild);
const decodePublishedBuild = Schema.decodeUnknownEffect(PublishedBuildJson);
const encodePublishedBuild = Schema.encodeEffect(PublishedBuildJson);

/** CI stamps `<base>-schnau.<run>`; Gitea run numbers only grow, whatever the base version. */
export function buildRunNumber(version: string): number | undefined {
  const match = /-schnau\.(\d+)$/.exec(version);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** Main's first-parent history is Gitea merge commits; show the pull request title instead. */
export function releaseNoteFromSubject(subject: string): string {
  const merge = /^Merge pull request '(.+)' \(#(\d+)\) from .+$/.exec(subject);
  return merge ? `${merge[1]} (#${merge[2]})` : subject;
}

export function readFeedVersion(feed: string): string | undefined {
  return /^version: '?([^'\n]+?)'?$/m.exec(feed)?.[1];
}

/** Replaces the feed's releaseNotes with a literal block, which the app's update pill renders. */
export function withReleaseNotes(feed: string, notes: ReadonlyArray<string>): string {
  const withoutNotes = feed.replace(/^releaseNotes:.*\n(?:[ \t].*\n)*/m, "").trimEnd();
  if (notes.length === 0) return `${withoutNotes}\n`;
  return `${withoutNotes}\nreleaseNotes: |\n${notes.map((note) => `  - ${note}`).join("\n")}\n`;
}

/** Zips beyond the newest `keep` (by run number) and their blockmaps. */
export function selectPrunableFiles(fileNames: ReadonlyArray<string>, keep: number): string[] {
  const zips = fileNames
    .filter((name) => name.endsWith(".zip"))
    .map((name) => ({ name, run: buildRunNumber(name.replace(/-arm64\.zip$/, "")) ?? -1 }))
    .toSorted((left, right) => right.run - left.run);
  return zips.slice(keep).flatMap(({ name }) => {
    const blockmap = `${name}.blockmap`;
    return fileNames.includes(blockmap) ? [name, blockmap] : [name];
  });
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function renderIndexHtml(input: {
  readonly version: string;
  readonly commit: string;
  readonly publishedAt: string;
  readonly notes: ReadonlyArray<string>;
  readonly feedUrl: string;
}): string {
  const notes = input.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>T3 Code Schnau ${escapeHtml(input.version)}</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px}code,pre{font-family:ui-monospace,Menlo,monospace}pre{background:#f1f0eb;padding:12px;border-radius:8px;overflow-x:auto}@media(prefers-color-scheme:dark){body{background:#151513;color:#e8e6df}pre{background:#23221f}}</style>
</head><body>
<h1>T3 Code Schnau</h1>
<p>Latest build <code>${escapeHtml(input.version)}</code> from commit <code>${escapeHtml(input.commit.slice(0, 12))}</code>, published ${escapeHtml(input.publishedAt)}.</p>
${notes ? `<ul>${notes}</ul>` : ""}
<p>Install or reinstall on an Apple Silicon Mac. The app updates itself after that.</p>
<pre>curl -fsSL ${escapeHtml(input.feedUrl)}/install.sh | sh</pre>
</body></html>
`;
}

/** Writes through a sibling temp file so the host never serves a partial file. */
const writeAtomically = Effect.fn("desktopPublish.writeAtomically")(function* (
  target: string,
  data: string | Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
  yield* typeof data === "string"
    ? fs.writeFileString(temporary, data)
    : fs.writeFile(temporary, data);
  yield* fs.rename(temporary, target);
});

/** Git output, or "" when git fails (for example when the range predates a shallow checkout). */
const git = Effect.fn("desktopPublish.git")(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .string(ChildProcess.make("git", [...args]))
    .pipe(Effect.orElseSucceed(() => ""));
});

const subjectLines = (output: string) =>
  output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** Commit subjects since the previous build, or just this commit's when history is shallower. */
const collectReleaseNotes = Effect.fn("desktopPublish.collectReleaseNotes")(function* (
  commit: string,
  previousCommit: string | undefined,
) {
  const sincePrevious = previousCommit
    ? subjectLines(
        yield* git(["log", "--first-parent", "--format=%s", `${previousCommit}..${commit}`]),
      )
    : [];
  const subjects =
    sincePrevious.length > 0
      ? sincePrevious
      : subjectLines(yield* git(["log", "-1", "--format=%s", commit]));
  return subjects.slice(0, MAX_RELEASE_NOTES).map(releaseNoteFromSubject);
});

const publishCommand = Command.make(
  "desktop-publish",
  {
    artifactsDir: Flag.Directory("artifacts-dir", { mustExist: true }).pipe(
      Flag.withDescription(
        "electron-builder output with latest-mac.yml, the zip and its blockmap.",
      ),
    ),
    updatesDir: Flag.Directory("updates-dir", { mustExist: true }),
    commit: Flag.String("commit").pipe(Flag.withDescription("Commit the build came from.")),
    feedUrl: Flag.String("feed-url").pipe(
      Flag.withDefault("https://t3code-updates.schnau.dev/desktop"),
    ),
    installScript: Flag.File("install-script", { mustExist: true }).pipe(
      Flag.withDefault("scripts/desktop-install.sh"),
    ),
  },
  Effect.fn("desktopPublish.publish")(function* ({
    artifactsDir,
    updatesDir,
    commit,
    feedUrl,
    installScript,
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const artifactNames = yield* fs.readDirectory(artifactsDir);
    const zips = artifactNames.filter((name) => name.endsWith("-arm64.zip"));
    const [zip] = zips;
    if (zips.length !== 1 || !zip || !artifactNames.includes(`${zip}.blockmap`)) {
      return yield* new DesktopPublishError({
        message: `Expected one arm64 zip with its blockmap in ${artifactsDir}, found: ${artifactNames.join(", ")}`,
      });
    }
    const feed = yield* fs.readFileString(path.join(artifactsDir, "latest-mac.yml"));
    const version = readFeedVersion(feed);
    const run = version === undefined ? undefined : buildRunNumber(version);
    if (version === undefined || run === undefined || !feed.includes(`url: ${zip}\n`)) {
      return yield* new DesktopPublishError({
        message: `latest-mac.yml does not describe a CI build of ${zip}.`,
      });
    }

    const publishedPath = path.join(updatesDir, "published.json");
    const previous = (yield* fs.exists(publishedPath))
      ? Option.some(yield* decodePublishedBuild(yield* fs.readFileString(publishedPath)))
      : Option.none();
    const previousRun = Option.flatMap(previous, (build) =>
      Option.fromNullishOr(buildRunNumber(build.version)),
    );
    if (Option.isSome(previousRun) && previousRun.value >= run) {
      yield* Console.log(`Keeping the published build, which is as new as ${version} or newer.`);
      return;
    }

    for (const name of [zip, `${zip}.blockmap`]) {
      yield* writeAtomically(
        path.join(updatesDir, name),
        yield* fs.readFile(path.join(artifactsDir, name)),
      );
    }
    const notes = yield* collectReleaseNotes(
      commit,
      Option.getOrUndefined(Option.map(previous, (build) => build.commit)),
    );
    const publishedAt = DateTime.formatIso(yield* DateTime.now);
    yield* writeAtomically(
      path.join(updatesDir, "install.sh"),
      yield* fs.readFileString(installScript),
    );
    yield* writeAtomically(
      path.join(updatesDir, "index.html"),
      renderIndexHtml({ version, commit, publishedAt, notes, feedUrl }),
    );
    // Clients act on the feed, so it moves only after everything it points at exists.
    yield* writeAtomically(path.join(updatesDir, "latest-mac.yml"), withReleaseNotes(feed, notes));
    yield* writeAtomically(publishedPath, yield* encodePublishedBuild({ version, commit }));

    const prunable = selectPrunableFiles(yield* fs.readDirectory(updatesDir), KEPT_BUILDS);
    yield* Effect.forEach(prunable, (name) => fs.remove(path.join(updatesDir, name)));
    yield* Console.log(
      `Published ${version} from ${commit.slice(0, 12)} with ${notes.length} release notes; pruned ${prunable.length} files.`,
    );
  }),
).pipe(Command.withDescription("Publish a packaged macOS build to the desktop update feed."));

if (import.meta.main) {
  Command.run(publishCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
