import {
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";

export const CLAUDEX_INSTANCE_ID = ProviderInstanceId.make("claudex");

/** Fork-provided profiles that should exist on every installation. */
export const BUNDLED_PROVIDER_INSTANCES: ProviderInstanceConfigMap = {
  [CLAUDEX_INSTANCE_ID]: {
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

const EXTERNALLY_MANAGED_PROVIDER_INSTANCES = new Set<ProviderInstanceId>([CLAUDEX_INSTANCE_ID]);

/** Claudex-specific runtime policy must not leak to every bundled profile. */
export function isClaudexInstance(instanceId: ProviderInstanceId): boolean {
  return instanceId === CLAUDEX_INSTANCE_ID;
}

export function isBundledProviderInstance(instanceId: ProviderInstanceId): boolean {
  return instanceId in BUNDLED_PROVIDER_INSTANCES;
}

/** Profiles whose executable lifecycle belongs to the host package manager. */
export function isExternallyManagedProviderInstance(instanceId: ProviderInstanceId): boolean {
  return EXTERNALLY_MANAGED_PROVIDER_INSTANCES.has(instanceId);
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
