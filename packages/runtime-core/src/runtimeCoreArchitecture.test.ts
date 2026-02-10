import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_FILES = [
  "index.ts",
  "processManager.ts",
  "todoStore.ts",
  "providerManager.ts",
  "codexAppServerManager.ts",
] as const;

describe("runtime-core architecture boundaries", () => {
  for (const fileName of SOURCE_FILES) {
    it(`${fileName} does not reach into app-layer paths`, () => {
      const filePath = path.resolve(import.meta.dirname, fileName);
      const source = fs.readFileSync(filePath, "utf8");

      expect(source).not.toContain("../apps/");
      expect(source).not.toContain("../../apps/");
      expect(source).not.toContain("../../../apps/");
    });
  }
});
