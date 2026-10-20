import { defineConfig, mergeConfig } from "vite-plus/test/config";
import "vite-plus/test/config";

import baseConfig from "../../vitest.config.ts";
import { isolatedTestFiles } from "../../packages/shared/src/testing/isolatedTestFiles.ts";
import { WeightedShardSequencer } from "./src/testUtils/weightedShardSequencer.ts";

const isolated = isolatedTestFiles(
  import.meta.dirname,
  ["src/**/*.test.ts", "integration/**/*.test.ts", "scripts/**/*.test.ts"],
  [
    // Loads a skill catalog, which sets the Codex pack root in SkillPackProviderScope for the
    // process. Codex replays in later files then send frames their transcripts don't have.
    "src/skills/SkillPacks.test.ts",
  ],
);

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      sequence: { sequencer: WeightedShardSequencer },
      setupFiles: ["./src/testUtils/gitConfig.setup.ts"],
      hookTimeout: 120_000,
      testTimeout: 120_000,
      // Most files share one module graph per worker: a fresh one per file took more CPU than
      // their tests. Transformed modules persist in node_modules/.vitest-cache between runs.
      fsModuleCache: true,
      projects: [
        { extends: true, test: { name: "isolated", include: isolated } },
        { extends: true, test: { name: "shared", exclude: isolated, isolate: false } },
      ],
    },
  }),
);
