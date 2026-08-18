import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import {
  BUNDLED_PROVIDER_INSTANCES,
  CLAUDEX_INSTANCE_ID,
  isBundledProviderInstance,
  isClaudexInstance,
  isExternallyManagedProviderInstance,
  withBundledProviderInstances,
} from "./bundledProviderInstances.ts";

describe("bundled provider instances", () => {
  const claudexId = CLAUDEX_INSTANCE_ID;

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
    expect(isClaudexInstance(claudexId)).toBe(true);
    expect(isClaudexInstance(ProviderInstanceId.make("claudeAgent"))).toBe(false);
  });

  it("marks the host-provided Claudex wrapper as externally managed", () => {
    expect(isExternallyManagedProviderInstance(claudexId)).toBe(true);
    expect(isExternallyManagedProviderInstance(ProviderInstanceId.make("claudeAgent"))).toBe(false);
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
