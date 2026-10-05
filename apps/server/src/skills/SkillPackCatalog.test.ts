import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { SkillId, SkillPackId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import {
  materializeSkillRoot,
  publicSkillPackCatalog,
  RuntimeSkillPackCatalog,
  selectPackSkills,
} from "./SkillPackCatalog.ts";
import * as ProviderScope from "./SkillPackProviderScope.ts";

const decodeCatalog = Schema.decodeSync(RuntimeSkillPackCatalog);
const pack = SkillPackId.make;

const catalog = decodeCatalog({
  version: 1,
  coreSkillIds: ["frontend-design"],
  skills: [
    { id: "frontend-design", path: "/store/frontend-design" },
    { id: "animate", path: "/store/animate", displayName: " Animate " },
    { id: "effect-docs", path: "/store/effect-docs" },
  ],
  packs: [
    {
      id: "web-craft",
      displayName: "Web craft",
      description: "Interface craft",
      skillIds: ["frontend-design", "animate"],
    },
    {
      id: "effect",
      displayName: "Effect",
      description: "Effect library",
      skillIds: ["effect-docs", "effect-patterns"],
    },
  ],
  profiles: [],
});

describe("SkillPackCatalog", () => {
  it("keeps runtime paths out of the public catalog", () => {
    assert.deepEqual(publicSkillPackCatalog(catalog).skills, [
      { id: SkillId.make("frontend-design"), displayName: "Frontend Design" },
      { id: SkillId.make("animate"), displayName: "Animate" },
      { id: SkillId.make("effect-docs"), displayName: "Effect Docs" },
    ]);
  });

  it("selects only the skills packs add beyond core and names what is missing", () => {
    const selection = selectPackSkills(catalog, [pack("effect"), pack("web-craft"), pack("gone")]);
    assert.deepEqual(
      selection.skills.map((skill) => skill.id),
      ["animate", "effect-docs"],
    );
    assert.deepEqual(selection.problems, [
      "Unknown packs: gone",
      "Missing skills: effect-patterns",
    ]);
  });

  it.layer(NodeServices.layer)("materialization", (it) => {
    it.effect("links skills into one content-addressed Claude plugin per selection", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skill-packs-" });
        const animate = path.join(stateDir, "canonical", "animate");
        yield* fileSystem.makeDirectory(animate, { recursive: true });
        yield* fileSystem.writeFileString(path.join(animate, "SKILL.md"), "animate");

        const skills = [{ id: SkillId.make("animate"), path: animate }];
        const root = yield* materializeSkillRoot(stateDir, skills);
        assert.equal(root.pluginPath, path.join(stateDir, "skill-scopes", root.key));
        assert.equal(yield* fileSystem.readLink(path.join(root.skillsPath, "animate")), animate);
        assert.match(
          yield* fileSystem.readFileString(
            path.join(root.pluginPath, ".claude-plugin", "plugin.json"),
          ),
          /"name":"skills"/u,
        );

        const repeated = yield* materializeSkillRoot(stateDir, skills);
        assert.equal(repeated.key, root.key);
      }),
    );
  });
});

describe("SkillPackProviderScope", () => {
  const root = (key: string, skillIds: ReadonlyArray<string>) => ({
    key,
    skillIds: skillIds.map((id) => SkillId.make(id)),
    skillsPath: `/state/skill-scopes/${key}/skills`,
    pluginPath: `/state/skill-scopes/${key}`,
  });

  it("hides the pack skills a Codex thread did not select and records what it loaded", () => {
    const threadId = ThreadId.make("codex-thread");
    ProviderScope.setCodexPackRoot(root("all", ["animate", "effect-docs"]));
    try {
      ProviderScope.setThreadSkillScope(threadId, root("web", ["animate"]));
      assert.deepEqual(ProviderScope.codexSkillPackRoots(), ["/state/skill-scopes/all/skills"]);
      assert.deepEqual(ProviderScope.codexThreadSkillConfig(threadId), {
        "skills.config": [
          { path: "/state/skill-scopes/all/skills/effect-docs/SKILL.md", enabled: false },
        ],
      });
      assert.equal(ProviderScope.loadedSkillScopeKey(threadId), "web");

      ProviderScope.setThreadSkillScope(threadId, undefined);
      assert.equal(ProviderScope.codexThreadSkillConfig(threadId)["skills.config"]?.length, 2);
      assert.equal(ProviderScope.loadedSkillScopeKey(threadId), "");
    } finally {
      ProviderScope.setCodexPackRoot(undefined);
    }
    assert.deepEqual(ProviderScope.codexThreadSkillConfig(threadId), {});
  });

  it("mounts a Claude thread's packs as a local plugin", () => {
    const threadId = ThreadId.make("claude-thread");
    assert.deepEqual(ProviderScope.claudeSkillPackPlugins(threadId), {});
    ProviderScope.setThreadSkillScope(threadId, root("web", ["animate"]));
    assert.deepEqual(ProviderScope.claudeSkillPackPlugins(threadId), {
      plugins: [{ type: "local", path: "/state/skill-scopes/web" }],
    });
  });

  it("adds the skill directory to a local OpenCode server's config", () => {
    const threadId = ThreadId.make("opencode-thread");
    const environment = {
      PATH: "/bin",
      OPENCODE_CONFIG_CONTENT: '{"model":"x","skills":{"paths":["/mine"]}}',
    };
    assert.equal(ProviderScope.withOpenCodeSkillPacks(threadId, environment), environment);
    ProviderScope.setThreadSkillScope(threadId, root("web", ["animate"]));
    const updated = ProviderScope.withOpenCodeSkillPacks(threadId, environment);
    assert.equal(updated.PATH, "/bin");
    assert.deepEqual(JSON.parse(updated.OPENCODE_CONFIG_CONTENT ?? ""), {
      model: "x",
      skills: { paths: ["/mine", "/state/skill-scopes/web/skills"] },
    });
  });
});
