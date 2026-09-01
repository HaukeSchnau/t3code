import * as NodeURL from "node:url";
import { defineConfig } from "vite-plus/test/config";
import "vite-plus/test/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^expo-crypto$/,
        replacement: NodeURL.fileURLToPath(
          new URL("./apps/mobile/src/test-support/expo-crypto.ts", import.meta.url),
        ),
      },
      {
        find: "~",
        replacement: NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "node",
    exclude: [
      "**/.repos/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
