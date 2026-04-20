#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import NodeOS from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };
import { resolveNightlyTargetVersion } from "./resolve-nightly-release.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const applicationsDir = "/Applications";

type DesktopInstallChannel = "alpha" | "nightly";

function parseChannel(rawChannel: string | undefined): DesktopInstallChannel {
  if (rawChannel === "alpha" || rawChannel === "nightly") {
    return rawChannel;
  }

  throw new Error("Usage: node scripts/install-local-desktop.ts <alpha|nightly>");
}

function assertSupportedPlatform(): void {
  if (process.platform !== "darwin") {
    throw new Error("desktop-install currently supports macOS only.");
  }

  if (process.arch !== "arm64" && process.arch !== "x64") {
    throw new Error(`Unsupported macOS desktop arch: ${process.arch}`);
  }
}

function resolveNightlyVersion(now: Date): string {
  const baseVersion = resolveNightlyTargetVersion(desktopPackageJson.version);
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const minute = String(now.getUTCMinutes()).padStart(2, "0");
  const second = String(now.getUTCSeconds()).padStart(2, "0");
  const runNumber = Number.parseInt(`${hour}${minute}${second}`, 10);
  return `${baseVersion}-nightly.${year}${month}${day}.${Math.max(runNumber, 1)}`;
}

function resolveBuildVersion(channel: DesktopInstallChannel): string {
  if (channel === "alpha") {
    return desktopPackageJson.version;
  }

  return resolveNightlyVersion(new Date());
}

function resolveInstalledAppName(channel: DesktopInstallChannel): string {
  return channel === "nightly" ? "T3 Code (Nightly).app" : "T3 Code (Alpha).app";
}

function resolveOtherAppName(channel: DesktopInstallChannel): string {
  return channel === "nightly" ? "T3 Code (Alpha).app" : "T3 Code (Nightly).app";
}

function runCommand(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): void {
  execFileSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: options?.env ?? process.env,
  });
}

function captureCommand(command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function quitDesktopApp(appName: string): void {
  try {
    execFileSync("osascript", ["-e", `tell application "${appName}" to quit`], {
      stdio: "ignore",
    });
  } catch {
    // Ignore if the app is not running.
  }
}

function verifyInstalledApp(
  appPath: string,
  expectedAppName: string,
  expectedVersion: string,
): void {
  const infoPlistPath = join(appPath, "Contents/Info.plist");
  const bundleName = captureCommand("plutil", ["-extract", "CFBundleName", "raw", infoPlistPath]);
  const shortVersion = captureCommand("plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    infoPlistPath,
  ]);
  const bundleVersion = captureCommand("plutil", [
    "-extract",
    "CFBundleVersion",
    "raw",
    infoPlistPath,
  ]);

  if (bundleName !== expectedAppName.replace(/\.app$/, "")) {
    throw new Error(
      `Installed app name mismatch: expected '${expectedAppName}', got '${bundleName}'.`,
    );
  }

  if (shortVersion !== expectedVersion || bundleVersion !== expectedVersion) {
    throw new Error(
      `Installed app version mismatch: expected '${expectedVersion}', got short='${shortVersion}' bundle='${bundleVersion}'.`,
    );
  }

  runCommand("codesign", ["--verify", "--deep", "--strict", appPath]);
}

function installDesktopApp(channel: DesktopInstallChannel): void {
  const buildVersion = resolveBuildVersion(channel);
  const installedAppName = resolveInstalledAppName(channel);
  const otherAppName = resolveOtherAppName(channel);
  const artifactZipPath = resolve(
    repoRoot,
    "release",
    `T3-Code-${buildVersion}-${process.arch}.zip`,
  );

  console.log(`Building ${channel} desktop artifact (${buildVersion})...`);
  runCommand(
    process.execPath,
    [
      resolve(repoRoot, "scripts/build-desktop-artifact.ts"),
      "--platform",
      "mac",
      "--target",
      "dmg",
      "--arch",
      process.arch,
    ],
    {
      env: {
        ...process.env,
        T3CODE_DESKTOP_VERSION: buildVersion,
      },
    },
  );

  if (!existsSync(artifactZipPath)) {
    throw new Error(`Expected desktop artifact not found at ${artifactZipPath}`);
  }

  const tempDir = mkdtempSync(join(NodeOS.tmpdir(), "t3code-desktop-install-"));
  try {
    console.log(`Installing ${installedAppName} from ${artifactZipPath}...`);
    quitDesktopApp("T3 Code (Nightly)");
    quitDesktopApp("T3 Code (Alpha)");

    runCommand("/usr/bin/ditto", ["-x", "-k", artifactZipPath, tempDir]);

    const stagedAppPath = join(tempDir, installedAppName);
    if (!existsSync(stagedAppPath)) {
      throw new Error(`Expected staged app bundle not found at ${stagedAppPath}`);
    }

    rmSync(join(applicationsDir, installedAppName), { recursive: true, force: true });
    rmSync(join(applicationsDir, otherAppName), { recursive: true, force: true });

    runCommand("/usr/bin/ditto", [stagedAppPath, join(applicationsDir, installedAppName)]);
    verifyInstalledApp(join(applicationsDir, installedAppName), installedAppName, buildVersion);

    console.log(`Installed ${installedAppName} (${buildVersion})`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const channel = parseChannel(process.argv[2]);
assertSupportedPlatform();
installDesktopApp(channel);
