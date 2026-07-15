import { assert, describe, it } from "@effect/vitest";

import {
  DIRECT_BROWSER_NETWORK_MATRIX_V1,
  DIRECT_BROWSER_NETWORK_SCENARIOS_V1,
  HOSTED_RELAY_BROWSER_MATRIX_V1,
  PRODUCTION_BROWSER_SELECTORS_V1,
} from "./browser-matrix.ts";

describe("direct Chromium network matrix", () => {
  it("keeps every required scenario in the CI-sized direct gate", () => {
    assert.deepStrictEqual(
      DIRECT_BROWSER_NETWORK_MATRIX_V1.map(({ id }) => id),
      [...DIRECT_BROWSER_NETWORK_SCENARIOS_V1],
    );
    assert.ok(DIRECT_BROWSER_NETWORK_MATRIX_V1.every(({ gating }) => gating));
    assert.equal(
      DIRECT_BROWSER_NETWORK_MATRIX_V1.find(({ id }) => id === "lost-acknowledgement")
        ?.requiresProtocolSuppression,
      true,
    );
  });

  it("uses production selectors and leaves hosted relay observational", () => {
    assert.equal(PRODUCTION_BROWSER_SELECTORS_V1.composer, '[data-testid="composer-editor"]');
    assert.equal(PRODUCTION_BROWSER_SELECTORS_V1.connectionStatus, "[data-train-network-status]");
    assert.equal(PRODUCTION_BROWSER_SELECTORS_V1.cachedTimeline, '[data-timeline-root="true"]');
    assert.equal(
      PRODUCTION_BROWSER_SELECTORS_V1.durableIntent,
      '[data-durable-outbox-strip="true"]',
    );
    assert.equal(HOSTED_RELAY_BROWSER_MATRIX_V1.gating, false);
  });
});
