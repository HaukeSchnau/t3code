import {
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";

/** Fork-provided profiles that should exist on every installation. */
export const BUNDLED_PROVIDER_INSTANCES: ProviderInstanceConfigMap = {
  [ProviderInstanceId.make("claudex")]: {
    driver: ProviderDriverKind.make("claudeAgent"),
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
  },
};

export function isBundledProviderInstance(instanceId: ProviderInstanceId): boolean {
  return instanceId in BUNDLED_PROVIDER_INSTANCES;
}

/** Explicit persisted settings win over bundled defaults. */
export function withBundledProviderInstances(
  providerInstances: ProviderInstanceConfigMap,
): ProviderInstanceConfigMap {
  return {
    ...BUNDLED_PROVIDER_INSTANCES,
    ...providerInstances,
  };
}
