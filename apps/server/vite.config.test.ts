import { describe, expect, it } from "vitest";

import packageJson from "./package.json" with { type: "json" };
import config from "./vite.config";

describe("server bundle configuration", () => {
  it("defines the CLI release channel from the package version", () => {
    const expectedChannel = packageJson.version.includes("-nightly.") ? "nightly" : "latest";

    expect(config.pack.define.__T3CODE_BUILD_CHANNEL__).toBe(JSON.stringify(expectedChannel));
  });
});
