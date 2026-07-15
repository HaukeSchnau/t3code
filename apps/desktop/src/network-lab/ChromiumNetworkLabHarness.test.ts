// @effect-diagnostics nodeBuiltinImport:off -- The smoke test owns a real ephemeral HTTP server.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeAssert from "node:assert/strict";

import { assert, describe, it } from "@effect/vitest";

import {
  finalizeChromiumIsolation,
  launchChromiumNetworkLabHarness,
  makeChromiumProductionT3Driver,
  type ChromiumNetworkFaultControl,
} from "./ChromiumNetworkLabHarness.ts";

const executablePath = process.env.T3_NETWORK_LAB_CHROMIUM;

const blackholeApply = {
  schemaVersion: 1,
  kind: "data-plane-blackhole",
  surface: "client-path",
  direction: "bidirectional",
  lifecycle: "apply",
  semantics: "drop-all-matching-data-plane-packets-v1",
} as const satisfies ChromiumNetworkFaultControl;

const blackholeRemove = {
  ...blackholeApply,
  lifecycle: "remove",
} as const satisfies ChromiumNetworkFaultControl;

const protocolSuppression = {
  schemaVersion: 1,
  kind: "protocol-suppression",
  surface: "application-protocol",
  direction: "origin-to-client",
  lifecycle: "apply",
  protocol: "effect-rpc",
  message: "acknowledgement",
  count: 1,
  semantics: "suppress-next-matching-complete-protocol-message-v1",
} as const satisfies ChromiumNetworkFaultControl;

async function listen(server: NodeHttp.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test server port.");
  return address.port;
}

async function closeServer(server: NodeHttp.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("real Chromium network-lab harness", () => {
  it("reports failed cleanup attempts even when post-state looks clean", async () => {
    const attempts: Array<string> = [];
    const contextFailure = await finalizeChromiumIsolation({
      closeContext: async () => {
        attempts.push("context");
        throw new Error("close rejected");
      },
      removeProfile: async () => {
        attempts.push("profile");
      },
      browserIsConnected: () => false,
      profileExists: () => false,
    });
    assert.deepStrictEqual(attempts, ["context", "profile"]);
    assert.deepStrictEqual(contextFailure, {
      browserDisconnected: false,
      temporaryDirectoryRemoved: true,
    });

    const removalFailure = await finalizeChromiumIsolation({
      closeContext: async () => undefined,
      removeProfile: async () => Promise.reject(new Error("rm rejected")),
      browserIsConnected: () => false,
      profileExists: () => false,
    });
    assert.deepStrictEqual(removalFailure, {
      browserDisconnected: true,
      temporaryDirectoryRemoved: false,
    });
  });

  it.skipIf(!executablePath)(
    "applies a proved fault and releases the browser, port, and temporary profile",
    async () => {
      if (!executablePath) throw new Error("skipIf failed to omit missing Chromium.");
      const server = NodeHttp.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<main data-testid="messages-timeline">cached content</main><div data-train-network-status="degraded">Offline</div>',
        );
      });
      const port = await listen(server);
      const harness = await launchChromiumNetworkLabHarness({ executablePath });
      const userDataDir = harness.userDataDir;

      try {
        await harness.page.goto(`http://127.0.0.1:${String(port)}`);
        assert.equal(
          await harness.page.locator('[data-testid="messages-timeline"]').innerText(),
          "cached content",
        );
        assert.ok((await harness.waitForVisible("[data-train-network-status]", 300)) <= 300);
        await harness.applyFault(blackholeApply, "apply-17");
        await harness.applyFault(blackholeRemove, "remove-17");
        assert.deepStrictEqual(
          harness.faultEvidence.map(({ decisionToken }) => decisionToken),
          ["apply-17", "remove-17"],
        );
        assert.ok(harness.traffic().requestCount >= 1);
      } finally {
        const cleanup = await harness.close();
        await closeServer(server);
        assert.deepStrictEqual(cleanup, {
          browserDisconnected: true,
          temporaryDirectoryRemoved: true,
        });
        assert.equal(NodeFS.existsSync(userDataDir), false);
        assert.equal(server.listening, false);
      }
    },
  );

  it.skipIf(!executablePath)(
    "fails closed when acknowledgement suppression has no real fixture control",
    async () => {
      if (!executablePath) throw new Error("skipIf failed to omit missing Chromium.");
      const harness = await launchChromiumNetworkLabHarness({ executablePath });
      try {
        await NodeAssert.rejects(
          harness.applyFault(protocolSuppression, "lost-ack-17"),
          /real server fixture control/,
        );
        assert.deepStrictEqual(harness.faultEvidence, []);
      } finally {
        await harness.close();
      }
    },
  );

  it.skipIf(!executablePath)(
    "refuses to sample a connected send control as offline durable acceptance",
    async () => {
      if (!executablePath) throw new Error("skipIf failed to omit missing Chromium.");
      const server = NodeHttp.createServer((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          '<input data-testid="composer-editor"><button aria-label="Send message">Send</button><main data-timeline-root="true">cached</main><div data-durable-outbox-strip="true"></div>',
        );
      });
      const port = await listen(server);
      const harness = await launchChromiumNetworkLabHarness({ executablePath });
      try {
        const driver = makeChromiumProductionT3Driver(harness);
        await driver.navigate(`http://127.0.0.1:${String(port)}`);
        await NodeAssert.rejects(
          driver.submitComposer({
            composerSelector: '[data-testid="composer-editor"]',
            submitSelector: 'button[aria-label="Send message"]',
            durableIntentSelector: '[data-durable-outbox-strip="true"]',
            text: "must stay local",
          }),
          /requires 'Save message for delivery'/,
        );
      } finally {
        await harness.close();
        await closeServer(server);
      }
    },
  );
});
