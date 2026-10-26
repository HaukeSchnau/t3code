// @effect-diagnostics-next-line nodeBuiltinImport:off -- Vite config runs before any Effect runtime.
import * as NodeFSP from "node:fs/promises";

import * as Hash from "effect/Hash";
import { playwright } from "vite-plus/test/browser-playwright";
import {
  defineConfig,
  defineProject,
  mergeConfig,
  type TestProjectInlineConfiguration,
} from "vite-plus/test/config";
import "vite-plus/test/config";

import {
  isolatedTestFiles,
  vmIncompatibleTestFiles,
} from "../../packages/shared/src/testing/isolatedTestFiles.ts";
import viteConfig from "./vite.config";

const include = ["src/**/*.test.{ts,tsx}"];
// Anything that renders React or touches the DOM runs in headless Chromium instead.
const browserInclude = ["src/**/*.browser.test.{ts,tsx}"];
const isolated = isolatedTestFiles(import.meta.dirname, include, []).filter(
  (file) => !file.includes(".browser.test."),
);
const vmIncompatible = vmIncompatibleTestFiles(isolated, [
  // Expects the error Node's URL throws to be this context's TypeError.
  "src/environments/primary/bootstrap.test.ts",
  // Replaces URL.createObjectURL, which belongs to the worker process, and never restores it.
  "src/components/settings/AcpRegistryIcon.test.ts",
]);

// The web runtime suite exercises auth bootstrap, saved environments,
// and websocket subscription lifecycles. Under the full monorepo test
// run, those async tests can exceed Vitest's default 5s budget.
const timeouts = { hookTimeout: 15_000, testTimeout: 15_000 };
const unitSetupFiles = [
  "../../packages/shared/src/testing/longTempDir.ts",
  "../../packages/shared/src/testing/providerEnv.ts",
];
// Heavy diff and pull request views used a whole 15 s budget waiting on clicks on loaded Calder
// workers, and Playwright's click waits share that budget.
const browserTimeouts = { hookTimeout: 30_000, testTimeout: 30_000 };

// Vitest's fixed browser API port (63315) collides when two checkouts run browser tests at once.
// Hash the checkout path like scripts/dev-runner.ts does, into 61000-64999 (above Linux's
// ephemeral range).
const browserTestApiPort = 61_000 + ((Hash.string(import.meta.dirname) >>> 0) % 4_000);
// Playwright's downloaded Chromium does not run on NixOS, so CI and NixOS hosts point this at
// nixpkgs' Chromium. Unset, Playwright launches its own build.
const chromiumExecutablePath = process.env.T3CODE_BROWSER_TEST_CHROMIUM?.trim() || undefined;

const browserTestProject = {
  extends: true,
  // Pre-bundle lazy browser and worker dependencies to avoid mid-run reloads.
  optimizeDeps: {
    include: [
      "vite-plus/test/browser",
      "@base-ui/react/autocomplete",
      "saxes",
      "@betteroffice/docx/editor",
      "@betteroffice/docx/layout",
      "@betteroffice/docx/layout/render",
      "@betteroffice/docx/yrs",
      "@betteroffice/fonts",
      "@betteroffice/pptx",
      "@betteroffice/xlsx",
      "@betteroffice/xlsx/headless",
      "fast-xml-parser",
      "entities",
      "dompurify",
      "heic-to/next",
      "jszip",
      "pdfjs-dist",
      "sql.js",
      "tiff",
    ],
  },
  test: {
    name: "browser",
    include: browserInclude,
    ...browserTimeouts,
    setupFiles: ["./test/browserSetup.ts"],
    api: { port: browserTestApiPort, strictPort: false },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(
        chromiumExecutablePath === undefined
          ? {}
          : { launchOptions: { executablePath: chromiumExecutablePath } },
      ),
      instances: [{ browser: "chromium" }],
      screenshotFailures: false,
      // Sessions connect once dependency optimization finishes, which took over a minute
      // with several sessions on a loaded CI host; Vitest's default allows one.
      connectTimeout: 300_000,
      commands: {
        // Playwright's mouse outlives each test, so whatever mounts under its last
        // position starts hovered. test/browserSetup.ts parks it off the page before each test.
        resetPointer: async ({ page }) => {
          await page.mouse.move(-1, -1);
        },
      },
    },
  },
} satisfies TestProjectInlineConfiguration;

// Render scenarios count React commits; they run only through scripts/render-metrics.ts,
// which reads the per-scenario reports this command writes.
const renderScenariosProject = {
  ...browserTestProject,
  test: {
    ...browserTestProject.test,
    name: "renders",
    include: ["test/*.renders.tsx"],
    // App scenarios mount the whole app per test, which outlasts 15s on a loaded machine.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    setupFiles: ["./test/renderCounter.ts", ...browserTestProject.test.setupFiles],
    browser: {
      ...browserTestProject.test.browser,
      // Vitest names each instance in place, so a shared array would clash with the browser project.
      instances: [{ browser: "chromium" }],
      commands: {
        ...browserTestProject.test.browser.commands,
        writeRenderReport: async (_context, scenario: string, json: string) => {
          const directory = process.env.T3CODE_RENDER_REPORT_DIR;
          if (!directory) throw new Error("T3CODE_RENDER_REPORT_DIR is not set");
          await NodeFSP.writeFile(`${directory}/${scenario}.json`, json);
        },
      },
    },
  },
} satisfies TestProjectInlineConfiguration;

export default defineConfig(async (configEnv) => {
  const resolvedViteConfig =
    typeof viteConfig === "function" ? await viteConfig(configEnv) : await viteConfig;

  return mergeConfig(resolvedViteConfig, {
    test: {
      // Transformed modules persist in node_modules/.vitest-cache between runs.
      fsModuleCache: true,
      // A VM worker's heap grows with every file. At the default limit three workers grew to 3.5 GB,
      // close to a Calder worker's 4.5 GB MemoryHigh. Replacing them at 512 MB cost no CPU.
      vmMemoryLimit: "512MB",
      projects: [
        // Most files share one module graph per worker: a fresh one per file took more CPU than
        // their tests.
        defineProject({
          extends: true,
          test: {
            name: "unit",
            include,
            exclude: [...isolated, ...browserInclude],
            isolate: false,
            setupFiles: unitSetupFiles,
            ...timeouts,
          },
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
            setupFiles: unitSetupFiles,
            ...timeouts,
          },
        }),
        defineProject({
          extends: true,
          test: {
            name: "unit-isolated",
            include: vmIncompatible,
            setupFiles: unitSetupFiles,
            ...timeouts,
          },
        }),
        defineProject(browserTestProject),
        defineProject(renderScenariosProject),
      ],
    },
  });
});
