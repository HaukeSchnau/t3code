import { defineConfig, mergeConfig } from "vite-plus/test/config";
import "vite-plus/test/config";

import baseConfig from "../../vitest.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide runs they can exceed the default budget on loaded CI hosts.
      hookTimeout: 120_000,
      testTimeout: 120_000,
    },
  }),
);
