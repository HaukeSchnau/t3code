// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses temporary Node paths.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as TestConsole from "effect/testing/TestConsole";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProcessRunner from "../processRunner.ts";
import { acquireServerOwnership } from "../serverOwnership.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerStatusHttp from "../status/http.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);
const ORIGIN = "http://127.0.0.1:3773";

const runCli = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    // The test console keeps earlier commands' lines.
    const seen = {
      stdout: (yield* TestConsole.logLines).length,
      stderr: (yield* TestConsole.errorLines).length,
    };
    yield* Command.runWith(cli, { version: "0.0.0" })(args);
    return {
      exitCode: process.exitCode,
      stdout: (yield* TestConsole.logLines).slice(seen.stdout).map(String).join("\n"),
      stderr: (yield* TestConsole.errorLines).slice(seen.stderr).map(String).join("\n"),
    };
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        process.exitCode = undefined;
      }),
    ),
    Effect.provide(Layer.mergeAll(layerCliRuntime, TestConsole.layer)),
  );

const makeHome = Effect.fn("SettingsCliTest.makeHome")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settings-cli-" });
  const baseDir = NodePath.join(root, "state");
  const file = (name: string, value: unknown) => {
    const path = NodePath.join(root, name);
    NodeFS.writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const settingsPath = NodePath.join(baseDir, "userdata", "settings.json");
  const settings = (...args: ReadonlyArray<string>) =>
    runCli(["settings", ...args, "--base-dir", baseDir]);
  return { root, baseDir, file, settingsPath, settings };
});

const persistRuntimeState = (baseDir: string) =>
  Effect.gen(function* () {
    yield* persistServerRuntimeState({
      path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: 3_773,
      }),
    });
  });

class SettingsRoutesApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.server) {}

// The real settings routes, auth and settings service on `baseDir`, without a listening socket.
// The web handler runs on the wall clock, so tests that use it are `it.live` to mint valid tokens.
const serveRoutes = Effect.fn("SettingsCliTest.serveRoutes")(function* (baseDir: string) {
  // The server runtime gives handlers these per request; the test hands them over itself.
  const services = yield* Layer.build(
    Layer.mergeAll(EnvironmentAuth.layer, ServerSettings.layer).pipe(
      // The real identity: tokens the CLI mints name the environment id stored in `baseDir`.
      Layer.provide([ManagedPolicy.layerTest(), ServerEnvironment.layer]),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(SqlitePersistence.layerConfig),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );
  const layer = HttpApiBuilder.layer(SettingsRoutesApi).pipe(
    Layer.provide(ServerStatusHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
    Layer.provideMerge(Layer.succeedContext(services)),
  );
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(layer, { disableLogger: true })),
    (web) => Effect.promise(() => web.dispose()),
  );
  yield* persistRuntimeState(baseDir);
  const tokens: Array<string> = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    if (token !== undefined) tokens.push(token);
    return handler(request, services);
  };
  const call = (method: "GET" | "POST", path: string, token: string, body?: unknown) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        services,
      );
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    });
  return { fetch, tokens, call };
});

const layerTest = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

it.live("reads and patches through the real routes, then revokes the CLI's session", () =>
  Effect.gen(function* () {
    const home = yield* makeHome();
    const server = yield* serveRoutes(home.baseDir);
    const patch = home.file("patch.json", { enableAgentBrowserAccess: false });

    const patched = yield* home
      .settings("patch", patch, "--json")
      .pipe(Effect.provideService(FetchHttpClient.Fetch, server.fetch));
    assert.deepEqual(JSON.parse(patched.stdout), {
      changes: [{ path: ["enableAgentBrowserAccess"], after: false }],
      dryRun: false,
      mode: "live",
      secrets: [],
      written: true,
    });
    assert.include(NodeFS.readFileSync(home.settingsPath, "utf8"), '"enableAgentBrowserAccess"');

    const token = server.tokens.at(-1)!;
    assert.equal((yield* server.call("GET", "/api/server/settings", token)).status, 401);
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.live("the routes require the RPC's scopes and answer T3's reason as a 400", () =>
  Effect.gen(function* () {
    const home = yield* makeHome();
    const server = yield* serveRoutes(home.baseDir);
    const issue = (...scopes: ReadonlyArray<string>) =>
      runCli([
        "auth",
        "session",
        "issue",
        ...scopes.flatMap((scope) => ["--scope", scope]),
        "--token-only",
        "--base-dir",
        home.baseDir,
      ]).pipe(Effect.map((result) => result.stdout.trim()));
    const reader = yield* issue("orchestration:read");
    const writer = yield* issue("orchestration:read", "settings:write", "providers:manage");

    const denied = yield* server.call("POST", "/api/server/settings", reader, {
      patch: { enableAgentBrowserAccess: false },
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.requiredPermission, "settings:write");
    const deniedApply = yield* server.call("POST", "/api/server/settings/apply", reader, {
      desired: {},
      dryRun: true,
    });
    assert.equal(deniedApply.status, 403);

    const rejected = yield* server.call("POST", "/api/server/settings", writer, {
      patch: { secretProviders: { vault: { kind: "nope", label: "Vault", config: {} } } },
    });
    assert.equal(rejected.status, 400);
    assert.include(String(rejected.body.message), "Unsupported secret provider kind: nope.");
    assert.isFalse(NodeFS.existsSync(home.settingsPath));
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.live("fails instead of printing defaults when settings.json does not decode", () =>
  Effect.gen(function* () {
    const home = yield* makeHome();
    NodeFS.mkdirSync(NodePath.dirname(home.settingsPath), { recursive: true });
    NodeFS.writeFileSync(home.settingsPath, '{"fastWorktreeCheckout": "yes"}\n');

    const offline = yield* home.settings("get", "--json");
    assert.equal(offline.exitCode, 1);
    assert.equal(offline.stdout, "");
    assert.match(offline.stderr, /read-file failed[\s\S]*fastWorktreeCheckout/);

    const server = yield* serveRoutes(home.baseDir);
    const live = yield* home
      .settings("get", "--json")
      .pipe(Effect.provideService(FetchHttpClient.Fetch, server.fetch));
    assert.equal(live.exitCode, 1);
    assert.match(live.stderr, /read-file failed[\s\S]*fastWorktreeCheckout/);
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect.each([
  {
    label: "falls back to offline when no server answers",
    respond: () => Promise.reject(new TypeError("fetch failed")),
    expected: { exitCode: undefined, mode: "offline" },
  },
  {
    label: "exits 75 when the running server is older than the CLI",
    respond: () => Promise.resolve(new Response("Not Found", { status: 404 })),
    expected: { exitCode: 75, mode: undefined },
  },
])("$label", ({ respond, expected }) =>
  Effect.gen(function* () {
    const home = yield* makeHome();
    yield* persistRuntimeState(home.baseDir);
    const result = yield* home
      .settings("get", "--json")
      .pipe(Effect.provideService(FetchHttpClient.Fetch, respond));
    assert.equal(result.exitCode, expected.exitCode);
    assert.equal(result.stdout === "" ? undefined : JSON.parse(result.stdout).mode, expected.mode);
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("exits 75 while another process owns the state directory", () =>
  Effect.gen(function* () {
    const home = yield* makeHome();
    yield* acquireServerOwnership(NodePath.join(home.baseDir, "userdata", "server-runtime.json"));

    const result = yield* home.settings("get");
    assert.equal(result.exitCode, 75);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /owns .* but did not answer[\s\S]*--wait/);
  }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(layerTest))), Effect.scoped),
);

it.effect("get --sparse is a document that apply and patch take back unchanged", () =>
  Effect.gen(function* () {
    const home = yield* makeHome();
    const workspace = NodePath.join(home.root, "workspace");
    NodeFS.mkdirSync(workspace);
    yield* runCli(["project", "add", workspace, "--base-dir", home.baseDir]);
    NodeFS.writeFileSync(
      home.settingsPath,
      JSON.stringify({
        defaultTheme: "t3-dark",
        defaultThemeSetAt: "1",
        enableAgentBrowserAccess: false,
        storageCleanup: { logsAfterDays: 7 },
      }),
    );

    const sparse = yield* home.settings("get", "--sparse", "--json");
    const document = JSON.parse(sparse.stdout).settings;
    assert.deepEqual(document, {
      enableAgentBrowserAccess: false,
      storageCleanup: { logsAfterDays: 7 },
    });
    const stored = NodeFS.readFileSync(home.settingsPath, "utf8");
    assert.include(stored, '"projectSettingsFolded": true');

    const desired = home.file("desired.json", document);
    for (const command of ["apply", "patch"]) {
      const result = yield* home.settings(command, desired, "--json");
      assert.deepInclude(JSON.parse(result.stdout), { changes: [], secrets: [], written: false });
    }
    assert.equal(NodeFS.readFileSync(home.settingsPath, "utf8"), stored);
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("reports a rotated secret and skips a patch that changes nothing", () =>
  Effect.gen(function* () {
    const home = yield* makeHome();
    const withKey = (value: string) =>
      home.file(`${value}.json`, {
        providerInstances: {
          codex: {
            driver: "codex",
            environment: [{ name: "OPENAI_API_KEY", value, sensitive: true }],
          },
        },
      });
    const secret = "providerInstances.codex.environment.OPENAI_API_KEY";
    const run = (file: string) =>
      home
        .settings("patch", file, "--json")
        .pipe(Effect.map((result) => JSON.parse(result.stdout)));

    assert.deepEqual((yield* run(withKey("sk-1"))).secrets, [{ secret, change: "set" }]);
    assert.deepInclude(yield* run(withKey("sk-2")), {
      changes: [],
      secrets: [{ secret, change: "set" }],
      written: true,
    });
    const before = NodeFS.statSync(home.settingsPath).mtimeMs;
    assert.deepInclude(yield* run(withKey("sk-2")), { secrets: [], written: false });
    assert.equal(NodeFS.statSync(home.settingsPath).mtimeMs, before);
    assert.notInclude(NodeFS.readFileSync(home.settingsPath, "utf8"), "sk-2");
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("apply makes the document true; with --base it leaves paths the repo did not touch", () =>
  Effect.gen(function* () {
    const home = yield* makeHome();
    const changedPaths = (stdout: string) =>
      JSON.parse(stdout).changes.map((change: { path: Array<string> }) => change.path.join("."));
    const base = home.file("base.json", { fastWorktreeCheckout: true });
    yield* home.settings("apply", base);
    // A UI edit the repo has not captured yet.
    yield* home.settings("patch", home.file("ui.json", { storageCleanup: { logsAfterDays: 7 } }));

    const desired = home.file("desired.json", {
      fastWorktreeCheckout: true,
      refreshGeneratedThreadTitles: false,
    });
    const preview = yield* home.settings("apply", desired, "--dry-run", "--json");
    assert.deepEqual(changedPaths(preview.stdout), [
      "refreshGeneratedThreadTitles",
      "storageCleanup.logsAfterDays",
    ]);
    assert.include(NodeFS.readFileSync(home.settingsPath, "utf8"), "logsAfterDays");

    const rebased = yield* home.settings("apply", desired, "--base", base, "--json");
    assert.deepEqual(changedPaths(rebased.stdout), ["refreshGeneratedThreadTitles"]);
    const after = JSON.parse((yield* home.settings("get", "--sparse", "--json")).stdout).settings;
    assert.deepEqual(after, {
      fastWorktreeCheckout: true,
      refreshGeneratedThreadTitles: false,
      storageCleanup: { logsAfterDays: 7 },
    });

    const rejected = yield* home.settings(
      "apply",
      home.file("bad.json", { compactIdleThreads: true }),
    );
    assert.equal(rejected.exitCode, 1);
    assert.match(rejected.stderr, /cannot set: compactIdleThreads/);
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("apply --base keeps a secret the UI added to an instance the repository changes", () =>
  Effect.gen(function* () {
    const home = yield* makeHome();
    const codex = (enabled: boolean) => ({ driver: "codex", enabled });
    const base = home.file("base.json", { providerInstances: { codex: codex(true) } });
    yield* home.settings("apply", base);
    yield* home.settings(
      "patch",
      home.file("ui.json", {
        providerInstances: {
          codex: {
            ...codex(true),
            environment: [{ name: "OPENAI_API_KEY", value: "sk-ui", sensitive: true }],
          },
        },
      }),
    );
    const secrets = NodeFS.readdirSync(NodePath.join(home.baseDir, "userdata", "secrets"));

    const desired = home.file("desired.json", { providerInstances: { codex: codex(false) } });
    const rebased = JSON.parse(
      (yield* home.settings("apply", desired, "--base", base, "--json")).stdout,
    );
    assert.deepInclude(rebased, { secrets: [], written: true });
    assert.deepEqual(
      NodeFS.readdirSync(NodePath.join(home.baseDir, "userdata", "secrets")),
      secrets,
    );
    const after = JSON.parse((yield* home.settings("get", "--sparse", "--json")).stdout).settings;
    assert.equal(after.providerInstances.codex.enabled, false);
    assert.equal(after.providerInstances.codex.environment[0].valueRedacted, true);

    // Without --base the document is the whole truth, so the secret goes with the variable.
    const replaced = JSON.parse((yield* home.settings("apply", desired, "--json")).stdout);
    assert.deepEqual(replaced.secrets, [
      { secret: "providerInstances.codex.environment.OPENAI_API_KEY", change: "removed" },
    ]);
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect.each([
  {
    label: "a field the per-host merge keeps",
    stored: { sourceControlHosts: { github: { preferSsh: true, accountPin: "me" } } },
    desired: { sourceControlHosts: { github: { preferSsh: true } } },
    error: /cannot reach the document[\s\S]*sourceControlHosts\.github\.accountPin/,
  },
  {
    label: "a source control host",
    stored: { sourceControlHosts: { github: { preferSsh: true } } },
    desired: {},
    error: /cannot remove sourceControlHosts entries: github/,
  },
  {
    label: "a saved-secret marker this host does not hold",
    stored: {},
    desired: {
      providerInstances: {
        codex: {
          driver: "codex",
          environment: [
            { name: "OPENAI_API_KEY", value: "", sensitive: true, valueRedacted: true },
          ],
        },
      },
    },
    error: /marks secrets as saved that this host does not hold: providerInstances\.codex/,
  },
])("apply refuses $label and writes nothing", ({ stored, desired, error }) =>
  Effect.gen(function* () {
    const home = yield* makeHome();
    yield* home.settings("patch", home.file("stored.json", stored));
    const before = NodeFS.existsSync(home.settingsPath)
      ? NodeFS.readFileSync(home.settingsPath, "utf8")
      : undefined;

    const result = yield* home.settings("apply", home.file("desired.json", desired));
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, error);
    const after = NodeFS.existsSync(home.settingsPath)
      ? NodeFS.readFileSync(home.settingsPath, "utf8")
      : undefined;
    assert.equal(after, before);
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("--live-only exits 75 instead of opening the T3 home", () =>
  Effect.gen(function* () {
    const home = yield* makeHome();
    const result = yield* home.settings("get", "--live-only");
    assert.equal(result.exitCode, 75);
    assert.match(result.stderr, /No running T3 Code server answered/);
    assert.isFalse(
      NodeFS.existsSync(NodePath.join(home.baseDir, "userdata", "server-owner.sqlite")),
    );
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);
