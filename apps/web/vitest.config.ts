import {
  defineConfig,
  defineProject,
  mergeConfig,
  type TestProjectInlineConfiguration,
} from "vite-plus/test/config";
import "vite-plus/test/config";

import viteConfig from "./vite.config";

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    include: ["src/**/*.test.{ts,tsx}"],
    // The web runtime suite exercises auth bootstrap, saved environments,
    // and websocket subscription lifecycles. Under the full monorepo test
    // run, those async tests can exceed Vitest's default 5s budget.
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
} satisfies TestProjectInlineConfiguration;

export default defineConfig(async (configEnv) => {
  const resolvedViteConfig =
    typeof viteConfig === "function" ? await viteConfig(configEnv) : await viteConfig;

  return mergeConfig(resolvedViteConfig, {
    test: {
      projects: [defineProject(unitTestProject)],
    },
  });
});
