// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses temporary Node paths.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as TestConsole from "effect/testing/TestConsole";

import { cli } from "../binCli.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

const runSettings = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    // The test console keeps earlier commands' lines.
    const seen = {
      stdout: (yield* TestConsole.logLines).length,
      stderr: (yield* TestConsole.errorLines).length,
    };
    yield* Command.runWith(cli, { version: "0.0.0" })(["settings", ...args]);
    return {
      exitCode: process.exitCode,
      stdout: (yield* TestConsole.logLines).slice(seen.stdout).map(String),
      stderr: (yield* TestConsole.errorLines).slice(seen.stderr).map(String),
    };
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        process.exitCode = undefined;
      }),
    ),
    Effect.provide(Layer.mergeAll(layerCliRuntime, TestConsole.layer)),
  );

const makeBaseDir = Effect.fn("SettingsCliTest.makeBaseDir")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-cli-" });
  return NodePath.join(root, "state");
});

const settingsPath = (baseDir: string) => NodePath.join(baseDir, "userdata", "settings.json");

it.effect("applies a patch offline through the settings service and reports what changed", () =>
  Effect.gen(function* () {
    const baseDir = yield* makeBaseDir();
    const patchFile = NodePath.join(NodePath.dirname(baseDir), "patch.json");
    NodeFS.writeFileSync(
      patchFile,
      JSON.stringify({
        enableAgentBrowserAccess: false,
        providerInstances: {
          codex: {
            driver: "codex",
            environment: [{ name: "OPENAI_API_KEY", value: "sk-test-secret", sensitive: true }],
          },
        },
      }),
    );

    const first = yield* runSettings(["patch", patchFile, "--json", "--base-dir", baseDir]);
    const applied = JSON.parse(first.stdout.join("\n"));
    assert.equal(applied.mode, "offline");
    assert.deepEqual(
      applied.changes.map((change: { path: Array<string> }) => change.path.join(".")),
      ["enableAgentBrowserAccess", "providerInstances.codex"],
    );
    assert.deepInclude(applied.changes[0], { before: true, after: false });
    assert.notInclude(NodeFS.readFileSync(settingsPath(baseDir), "utf8"), "sk-test-secret");

    const again = yield* runSettings(["patch", patchFile, "--json", "--base-dir", baseDir]);
    assert.deepEqual(JSON.parse(again.stdout.join("\n")).changes, []);

    const sparse = yield* runSettings(["get", "--sparse", "--json", "--base-dir", baseDir]);
    assert.deepInclude(JSON.parse(sparse.stdout.join("\n")).settings, {
      enableAgentBrowserAccess: false,
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("rejects a patch with an unknown key and leaves settings.json untouched", () =>
  Effect.gen(function* () {
    const baseDir = yield* makeBaseDir();
    const patchFile = NodePath.join(NodePath.dirname(baseDir), "patch.json");
    NodeFS.writeFileSync(patchFile, JSON.stringify({ enableAgentBrowserAccess: false }));
    yield* runSettings(["patch", patchFile, "--base-dir", baseDir]);
    const stored = NodeFS.readFileSync(settingsPath(baseDir), "utf8");

    NodeFS.writeFileSync(patchFile, JSON.stringify({ enableAgentBrowserAcess: true }));
    const rejected = yield* runSettings(["patch", patchFile, "--json", "--base-dir", baseDir]);

    assert.equal(rejected.exitCode, 1);
    assert.deepEqual(rejected.stdout, []);
    assert.match(
      rejected.stderr.join("\n"),
      /Invalid settings patch[\s\S]*enableAgentBrowserAcess/,
    );
    assert.equal(NodeFS.readFileSync(settingsPath(baseDir), "utf8"), stored);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

const encodedDefaults = Schema.encodeSync(ServerSettings)(DEFAULT_SERVER_SETTINGS);

it.effect.each([
  {
    label: "applies through the running server",
    respond: (method: string, body: unknown) =>
      Response.json(
        method === "POST"
          ? { ...encodedDefaults, ...(body as { patch: object }).patch }
          : encodedDefaults,
      ),
    expected: { exitCode: undefined, mode: "live", changes: 1 },
  },
  {
    label: "falls back to offline when no server answers",
    respond: () => {
      throw new TypeError("fetch failed");
    },
    expected: { exitCode: undefined, mode: "offline", changes: 1 },
  },
  {
    label: "does not retry offline when the running server rejects the patch",
    respond: (method: string) =>
      method === "POST"
        ? Response.json(
            { _tag: "EnvironmentHttpBadRequestError", message: "locked by policy" },
            { status: 400 },
          )
        : Response.json(encodedDefaults),
    expected: { exitCode: 1, mode: undefined, changes: 0 },
  },
])("$label", ({ respond, expected }) =>
  Effect.gen(function* () {
    const baseDir = yield* makeBaseDir();
    yield* persistServerRuntimeState({
      path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: 3_773,
      }),
    });
    const requests: Array<{ method: string; body: unknown; authorized: boolean }> = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const body: unknown = request.method === "POST" ? await request.json() : undefined;
      requests.push({
        method: request.method,
        body,
        authorized: request.headers.get("authorization")?.startsWith("Bearer ") ?? false,
      });
      return respond(request.method, body);
    };
    const input = JSON.stringify({ enableAgentBrowserAccess: false });
    const patchFile = NodePath.join(NodePath.dirname(baseDir), "patch.json");
    NodeFS.writeFileSync(patchFile, input);

    const result = yield* runSettings(["patch", patchFile, "--json", "--base-dir", baseDir]).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );

    assert.equal(result.exitCode, expected.exitCode);
    const output = result.stdout.length > 0 ? JSON.parse(result.stdout.join("\n")) : undefined;
    assert.equal(output?.mode, expected.mode);
    assert.lengthOf(output?.changes ?? [], expected.changes);
    assert.isTrue(requests.every((request) => request.authorized));
    if (expected.mode !== "offline") {
      assert.deepEqual(requests.at(-1)?.body, { patch: JSON.parse(input) });
      assert.isFalse(NodeFS.existsSync(settingsPath(baseDir)));
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
