import { defineConfig, defineProject, mergeConfig } from "vite-plus/test/config";
import "vite-plus/test/config";

import { isolatedTestFiles } from "../../packages/shared/src/testing/isolatedTestFiles.ts";
import viteConfig from "./vite.config";

const include = ["src/**/*.test.{ts,tsx}"];
const isolated = isolatedTestFiles(import.meta.dirname, include, []);

// The web runtime suite exercises auth bootstrap, saved environments,
// and websocket subscription lifecycles. Under the full monorepo test
// run, those async tests can exceed Vitest's default 5s budget.
const timeouts = { hookTimeout: 15_000, testTimeout: 15_000 };

export default defineConfig(async (configEnv) => {
  const resolvedViteConfig =
    typeof viteConfig === "function" ? await viteConfig(configEnv) : await viteConfig;

  return mergeConfig(resolvedViteConfig, {
    test: {
      // Transformed modules persist in node_modules/.vitest-cache between runs.
      fsModuleCache: true,
      projects: [
        // Most files share one module graph per worker: a fresh one per file took more CPU than
        // their tests.
        defineProject({
          extends: true,
          test: { name: "unit", include, exclude: isolated, isolate: false, ...timeouts },
        }),
        defineProject({
          extends: true,
          test: { name: "unit-isolated", include: isolated, ...timeouts },
        }),
      ],
    },
  });
});
