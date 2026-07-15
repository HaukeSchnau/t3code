export const DIRECT_BROWSER_NETWORK_SCENARIOS_V1 = [
  "clean",
  "poor",
  "blackhole",
  "flap-handover",
  "reload",
  "lost-acknowledgement",
] as const;

export type DirectBrowserNetworkScenario = (typeof DIRECT_BROWSER_NETWORK_SCENARIOS_V1)[number];

export const PRODUCTION_BROWSER_SELECTORS_V1 = {
  composer: '[data-testid="composer-editor"]',
  connectionStatus: "[data-train-network-status]",
  cachedTimeline: '[data-timeline-root="true"]',
  durableIntent: '[data-durable-outbox-strip="true"]',
} as const;

export interface DirectBrowserScenarioDefinition {
  readonly id: DirectBrowserNetworkScenario;
  readonly gating: false;
  readonly requiresReload: boolean;
  readonly requiresProtocolSuppression: boolean;
  readonly faultKinds: ReadonlyArray<string>;
}

export const DIRECT_BROWSER_NETWORK_MATRIX_V1: ReadonlyArray<DirectBrowserScenarioDefinition> = [
  {
    id: "clean",
    gating: false,
    requiresReload: false,
    requiresProtocolSuppression: false,
    faultKinds: ["directional-impairment"],
  },
  {
    id: "poor",
    gating: false,
    requiresReload: false,
    requiresProtocolSuppression: false,
    faultKinds: ["directional-impairment"],
  },
  {
    id: "blackhole",
    gating: false,
    requiresReload: false,
    requiresProtocolSuppression: false,
    faultKinds: ["data-plane-blackhole"],
  },
  {
    id: "flap-handover",
    gating: false,
    requiresReload: false,
    requiresProtocolSuppression: false,
    faultKinds: ["link-state", "data-plane-reset"],
  },
  {
    id: "reload",
    gating: false,
    requiresReload: true,
    requiresProtocolSuppression: false,
    faultKinds: ["link-state"],
  },
  {
    id: "lost-acknowledgement",
    gating: false,
    requiresReload: false,
    requiresProtocolSuppression: true,
    faultKinds: ["protocol-suppression"],
  },
];

export const DIRECT_BROWSER_NETWORK_MATRIX_READINESS_V1 = {
  schemaVersion: 1,
  status: "blocked",
  gating: false,
  blockerId: "browser-ready-deterministic-t3-fixture",
  reason:
    "The repository has no fixture that composes the production authenticated web surface with deterministic provider/oracle state and protocol suppression.",
  requiredCapabilities: [
    "production-http-web-auth",
    "active-deterministic-thread",
    "deterministic-provider-oracle",
    "external-protocol-suppression-adapter",
    "isolated-baseline-candidate-runs",
  ],
} as const;

export function assertDirectBrowserNetworkMatrixReady(): never {
  throw new Error(
    `${DIRECT_BROWSER_NETWORK_MATRIX_READINESS_V1.blockerId}: ${DIRECT_BROWSER_NETWORK_MATRIX_READINESS_V1.reason}`,
  );
}

export const HOSTED_RELAY_BROWSER_MATRIX_V1 = {
  topology: "managed-relay",
  gating: false,
  reason: "Hosted relay remains observational until the direct Chromium matrix is stable.",
} as const;
