// @effect-diagnostics nodeBuiltinImport:off -- real subprocess protocol fixture.
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { probeCodexSkillsForCwd } from "./CodexProvider.ts";

it.effect("lists workspace skills without requesting project setup", () =>
  Effect.gen(function* () {
    if ((yield* HostProcessPlatform) === "win32") return;
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-probe-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    const peer = NodePath.join(root, "peer.cjs");
    NodeFS.writeFileSync(
      peer,
      `#!${process.execPath}
      if (process.env.AGENT_EXEC_ENVIRONMENT !== "baseline") process.exit(41);
      const fs = require("node:fs");
      require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        let result;
        if (request.method === "initialize") result = {
          codexHome: process.env.CODEX_HOME, platformFamily: "unix", platformOs: "linux", userAgent: "codex/test"
        };
        else if (request.method === "skills/list") {
          fs.writeFileSync("requested-cwd", request.params.cwds[0]);
          result = { data: [] };
        } else process.exit(42);
        process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n");
      });
    `,
      { mode: 0o755 },
    );
    const environment = { AGENT_EXEC_ENVIRONMENT: "auto" };
    const skills = yield* probeCodexSkillsForCwd({
      binaryPath: peer,
      homePath: root,
      cwd: root,
      environment,
    });
    assert.deepEqual(skills, []);
    assert.equal(NodeFS.readFileSync(NodePath.join(root, "requested-cwd"), "utf8"), root);
    assert.equal(environment.AGENT_EXEC_ENVIRONMENT, "auto");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
