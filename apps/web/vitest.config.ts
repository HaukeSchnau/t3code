import { defineConfig, defineProject, mergeConfig } from "vite-plus/test/config";
import "vite-plus/test/config";

import {
  isolatedTestFiles,
  vmIncompatibleTestFiles,
} from "../../packages/shared/src/testing/isolatedTestFiles.ts";
import viteConfig from "./vite.config";

const include = ["src/**/*.test.{ts,tsx}"];
const isolated = isolatedTestFiles(import.meta.dirname, include, []);
const vmIncompatible = vmIncompatibleTestFiles(import.meta.dirname, isolated, [
  // Expects the error Node's URL throws to be this context's TypeError.
  "src/environments/primary/bootstrap.test.ts",
  // Vitest 5.0.1's VM loader imports lucide-react/dynamic's DynamicIcon as a module object.
  "src/components/settings/ProjectIconPickerDialog.test.tsx",
  // Replaces URL.createObjectURL, which belongs to the worker process, and never restores it.
  "src/components/settings/AcpRegistryIcon.test.ts",
]);

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
      // A VM worker's heap grows with every file. At the default limit three workers grew to 3.5 GB,
      // close to a Kiln worker's 4.5 GB MemoryHigh. Replacing them at 512 MB cost no CPU.
      vmMemoryLimit: "512MB",
      projects: [
        // Most files share one module graph per worker: a fresh one per file took more CPU than
        // their tests.
        defineProject({
          extends: true,
          test: { name: "unit", include, exclude: isolated, isolate: false, ...timeouts },
        }),
        // Files that mock or stub get a VM context each, in workers that run many files. A process
        // per file cost most of the suite's CPU.
        defineProject({
          extends: true,
          test: {
            name: "unit-vm",
            include: isolated,
            exclude: vmIncompatible,
            pool: "vmForks",
            ...timeouts,
          },
        }),
        defineProject({
          extends: true,
          test: { name: "unit-isolated", include: vmIncompatible, ...timeouts },
        }),
      ],
    },
  });
});
