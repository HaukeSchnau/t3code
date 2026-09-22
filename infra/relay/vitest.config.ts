import { defineConfig, mergeConfig } from "vite-plus/test/config";
import baseConfig from "../../vitest.config";

export default mergeConfig(
  baseConfig,
  defineConfig({
    resolve: { alias: [{ find: /^vitest$/, replacement: "vite-plus/test" }] },
    test: {
      // TODO: Remove when Alchemy supports Vite Plus hooks directly.
      server: { deps: { inline: ["alchemy"] } },
    },
  }),
);
