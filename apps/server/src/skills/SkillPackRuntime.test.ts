import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PositiveInt, SkillId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import {
  materializeSkillScope,
  publicSkillPackCatalog,
  RuntimeSkillPackCatalog,
} from "./SkillPackRuntime.ts";

const decodeCatalog = Schema.decodeSync(RuntimeSkillPackCatalog);

describe("SkillPackRuntime", () => {
  it.layer(NodeServices.layer)("materialization", (it) => {
    it.effect("creates one content-addressed Claude plugin and provider skill root", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skill-packs-" });
        const frontendSkill = path.join(baseDir, "canonical", "frontend-design");
        const htmlSkill = path.join(baseDir, "canonical", "html-communication");
        yield* fileSystem.makeDirectory(frontendSkill, { recursive: true });
        yield* fileSystem.makeDirectory(htmlSkill, { recursive: true });
        yield* fileSystem.writeFileString(path.join(frontendSkill, "SKILL.md"), "frontend");
        yield* fileSystem.writeFileString(path.join(htmlSkill, "SKILL.md"), "html");
        const catalog = decodeCatalog({
          version: 1,
          coreSkillIds: ["html-communication"],
          skills: [
            { id: "frontend-design", path: frontendSkill },
            { id: "html-communication", path: htmlSkill },
          ],
          packs: [
            {
              id: "web-craft",
              displayName: "Web craft",
              description: "Web interface craft",
              skillIds: ["frontend-design", "html-communication"],
            },
          ],
          profiles: [],
        });

        const result = yield* materializeSkillScope({
          catalog,
          packIds: [catalog.packs[0]!.id],
          version: PositiveInt.make(1),
        }).pipe(Effect.provide(ServerConfig.layerTest(baseDir, baseDir)));

        assert.equal(result.issue, undefined);
        assert.ok(result.scope);
        assert.deepEqual(result.scope.skillIds, ["frontend-design", "html-communication"]);
        assert.equal(
          yield* fileSystem.readLink(path.join(result.scope.skillsPath, "frontend-design")),
          frontendSkill,
        );
        assert.match(
          yield* fileSystem.readFileString(
            path.join(result.scope.pluginPath, ".claude-plugin", "plugin.json"),
          ),
          /t3-skill-scope-/u,
        );

        const repeated = yield* materializeSkillScope({
          catalog,
          packIds: [catalog.packs[0]!.id],
          version: PositiveInt.make(1),
        }).pipe(Effect.provide(ServerConfig.layerTest(baseDir, baseDir)));
        assert.equal(repeated.scope?.pluginPath, result.scope.pluginPath);
      }),
    );

    it("keeps runtime paths out of the public catalog", () => {
      const catalog = decodeCatalog({
        version: 1,
        coreSkillIds: [],
        skills: [{ id: "frontend-design", path: "/private/store/frontend-design" }],
        packs: [],
        profiles: [],
      });

      assert.deepEqual(publicSkillPackCatalog(catalog).skills, [
        { id: SkillId.make("frontend-design"), displayName: "Frontend Design" },
      ]);
    });
  });
});
