#!/usr/bin/env node
// Packages and signs the macOS build of the fork's desktop update feed
// (patches/desktop-distribution.md). Calder's desktop-package step runs it on the
// Apple builder; desktop-publish.ts then publishes what it leaves in --output-dir.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { updateReleasePackageVersions } from "./update-release-package-versions.ts";

class DesktopPackageError extends Schema.TaggedError<DesktopPackageError>()("DesktopPackageError", {
  message: Schema.String,
}) {}

const decodePackageVersion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

/** What the update feed serves. Nothing else leaves the builder. */
const feedFile = /^(?:.+-arm64\.zip(?:\.blockmap)?|latest-mac\.yml)$/;

const packageCommand = Command.make(
  "desktop-package",
  {
    outputDir: Flag.String("output-dir").pipe(
      Flag.withDescription("Where the zip, its blockmap and latest-mac.yml land."),
    ),
  },
  Effect.fn("desktopPackage.package")(function* ({ outputDir }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    // electron-updater only installs a strictly higher version.
    const { version } = yield* decodePackageVersion(
      yield* fs.readFileString("apps/desktop/package.json"),
    );
    const seconds = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    yield* updateReleasePackageVersions(`${version}-schnau.${seconds}`);

    yield* fs.remove(outputDir, { recursive: true, force: true });
    const exitCode = yield* spawner.exitCode(
      ChildProcess.make(
        "node",
        [
          "scripts/build-desktop-artifact.ts",
          "--platform",
          "mac",
          "--target",
          "zip",
          "--arch",
          "arm64",
          "--signed",
          "--output-dir",
          outputDir,
        ],
        {
          env: {
            // Urbs UG's Apple Development identity in the builder's login keychain. The team-based
            // designated requirement keeps updates and macOS permissions working when it is replaced.
            CSC_NAME: "Apple Development: Created via API (85N8Y9CZC4)",
            T3CODE_APPLE_TEAM_ID: "2243J9RD68",
            T3CODE_DESKTOP_UPDATE_URL: "https://t3code-updates.schnau.dev/desktop",
          },
          extendEnv: true,
          stdin: "ignore",
          stdout: "inherit",
          stderr: "inherit",
        },
      ),
    );
    if (exitCode !== 0) {
      return yield* new DesktopPackageError({
        message: `build-desktop-artifact.ts exited with ${exitCode}.`,
      });
    }

    const extra = (yield* fs.readDirectory(outputDir)).filter((name) => !feedFile.test(name));
    yield* Effect.forEach(extra, (name) =>
      fs.remove(path.join(outputDir, name), { recursive: true }),
    );
  }),
).pipe(Command.withDescription("Package and sign the macOS build of the desktop update feed."));

if (import.meta.main) {
  Command.run(packageCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
