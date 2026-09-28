import { assert, it } from "@effect/vitest";

import {
  buildRunNumber,
  readFeedVersion,
  releaseNoteFromSubject,
  selectPrunableFiles,
  withReleaseNotes,
} from "./desktop-publish.ts";

const feed = `version: 0.0.42-schnau.612
files:
  - url: T3-Code-0.0.42-schnau.612-arm64.zip
    sha512: abc==
    size: 130487584
path: T3-Code-0.0.42-schnau.612-arm64.zip
sha512: abc==
releaseDate: '2026-09-28T13:10:00.000Z'
`;

it("orders builds by the CI run number, across base version bumps", () => {
  assert.strictEqual(buildRunNumber("0.0.42-schnau.612"), 612);
  assert.strictEqual(buildRunNumber("0.0.42"), undefined);
  assert.strictEqual(readFeedVersion(feed), "0.0.42-schnau.612");
  assert.strictEqual(readFeedVersion("version: '0.0.43-schnau.7'\n"), "0.0.43-schnau.7");
});

it("turns Gitea merge subjects into pull request titles", () => {
  assert.strictEqual(
    releaseNoteFromSubject(
      "Merge pull request 'feat(mobile): ship every green main commit to the iPhone' (#23) from feat/mobile-distribution into main",
    ),
    "feat(mobile): ship every green main commit to the iPhone (#23)",
  );
  assert.strictEqual(releaseNoteFromSubject("fix: direct commit"), "fix: direct commit");
});

it("replaces the feed's release notes instead of appending a second block", () => {
  const once = withReleaseNotes(feed, ["fix: one"]);
  const twice = withReleaseNotes(once, ["fix: two", "feat: three"]);

  assert.isTrue(once.endsWith("releaseNotes: |\n  - fix: one\n"));
  assert.isTrue(twice.startsWith(feed.trimEnd()));
  assert.isTrue(twice.endsWith("releaseNotes: |\n  - fix: two\n  - feat: three\n"));
  assert.notInclude(twice, "fix: one");
  assert.strictEqual(withReleaseNotes(twice, []), `${feed.trimEnd()}\n`);
});

it("prunes all but the newest builds, with their blockmaps", () => {
  const names = [
    "latest-mac.yml",
    "install.sh",
    "T3-Code-0.0.42-schnau.9-arm64.zip",
    "T3-Code-0.0.42-schnau.9-arm64.zip.blockmap",
    "T3-Code-0.0.42-schnau.10-arm64.zip",
    "T3-Code-0.0.42-schnau.10-arm64.zip.blockmap",
    "T3-Code-0.0.43-schnau.11-arm64.zip",
    "T3-Code-0.0.43-schnau.11-arm64.zip.blockmap",
  ];

  assert.deepStrictEqual(selectPrunableFiles(names, 2), [
    "T3-Code-0.0.42-schnau.9-arm64.zip",
    "T3-Code-0.0.42-schnau.9-arm64.zip.blockmap",
  ]);
  assert.deepStrictEqual(selectPrunableFiles(names, 3), []);
});
