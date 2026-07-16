import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  BUNDLED_PROVIDER_INSTANCES,
  isBundledProviderInstance,
  withBundledProviderInstances,
} from "./bundledProviderInstances.ts";

describe("bundled provider instances", () => {
  const claudexId = ProviderInstanceId.make("claudex");

  it("provides Claudex as an enabled Claude profile", () => {
    expect(BUNDLED_PROVIDER_INSTANCES[claudexId]).toEqual({
      driver: "claudeAgent",
      displayName: "Claudex",
      accentColor: "#f97316",
      enabled: true,
      config: {
        binaryPath: "claudex",
        homePath: "",
        includeBuiltInModels: false,
        customModels: ["gpt-5.6-sol"],
        launchArgs: "",
      },
    });
    expect(isBundledProviderInstance(claudexId)).toBe(true);
    expect(isBundledProviderInstance(ProviderInstanceId.make("claudeAgent"))).toBe(false);
  });

  it("restores a missing bundled profile without overwriting user settings", () => {
    expect(withBundledProviderInstances({})[claudexId]?.enabled).toBe(true);

    const customized = withBundledProviderInstances({
      [claudexId]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "My Claudex",
        enabled: false,
        config: { binaryPath: "/custom/claudex" },
      },
    });
    expect(customized[claudexId]).toEqual({
      driver: "claudeAgent",
      displayName: "My Claudex",
      enabled: false,
      config: { binaryPath: "/custom/claudex" },
    });
  });
});
