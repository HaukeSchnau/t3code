// @effect-diagnostics nodeBuiltinImport:off -- This integration harness owns browser process and temporary-directory boundaries.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import type {
  ProductionBrowserDriver,
  ProductionBrowserSubmissionEvidence,
} from "../../../../scripts/lib/production-browser-driver.ts";

export interface ChromiumNetworkFaultControl {
  readonly schemaVersion?: number;
  readonly kind:
    | "protocol-suppression"
    | "data-plane-reset"
    | "link-state"
    | "data-plane-blackhole"
    | "directional-impairment";
  readonly lifecycle: "apply" | "remove";
  readonly surface?: string;
  readonly direction?: string;
  readonly state?: string;
  readonly semantics?: unknown;
  readonly protocol?: string;
  readonly message?: string;
  readonly count?: number;
  readonly parameters?: {
    readonly latencyMs: number;
    readonly lossPercent: number;
    readonly bandwidthKbps: number | null;
  };
}

export interface ChromiumTrafficSnapshot {
  readonly bytesSent: number;
  readonly bytesReceived: number;
  readonly requestCount: number;
  readonly eventCount: number;
}

export interface AppliedChromiumFault {
  readonly decisionToken: string;
  readonly control: ChromiumNetworkFaultControl;
  readonly appliedAtMs: number;
  readonly mechanism: "chromium-cdp" | "external-protocol-suppression-adapter";
}

export interface ChromiumNetworkLabHarnessOptions {
  readonly executablePath?: string;
  readonly now?: () => number;
  readonly protocolControl?: (
    control: ChromiumNetworkFaultControl,
    decisionToken: string,
  ) => Promise<void>;
}

export interface ChromiumNetworkLabHarness {
  readonly page: Page;
  readonly userDataDir: string;
  readonly faultEvidence: ReadonlyArray<AppliedChromiumFault>;
  readonly traffic: () => ChromiumTrafficSnapshot;
  readonly applyFault: (
    control: ChromiumNetworkFaultControl,
    decisionToken: string,
  ) => Promise<{
    readonly decisionToken: string;
    readonly effectiveControl: ChromiumNetworkFaultControl;
  }>;
  readonly waitForVisible: (selector: string, timeoutMs: number) => Promise<number>;
  readonly close: () => Promise<{
    readonly browserDisconnected: boolean;
    readonly temporaryDirectoryRemoved: boolean;
  }>;
}

export type ChromiumProductionT3Driver = ProductionBrowserDriver<ChromiumNetworkFaultControl>;

interface MutableTraffic {
  bytesSent: number;
  bytesReceived: number;
  requestCount: number;
  eventCount: number;
}

function payloadBytes(payload: string): number {
  return Buffer.byteLength(payload, "utf8");
}

export async function finalizeChromiumIsolation(input: {
  readonly closeContext: () => Promise<void>;
  readonly removeProfile: () => Promise<void>;
  readonly browserIsConnected: () => boolean;
  readonly profileExists: () => boolean;
}): Promise<{
  readonly browserDisconnected: boolean;
  readonly temporaryDirectoryRemoved: boolean;
}> {
  const [contextClose] = await Promise.allSettled([input.closeContext()]);
  const [profileRemoval] = await Promise.allSettled([input.removeProfile()]);
  return {
    browserDisconnected: contextClose?.status === "fulfilled" && !input.browserIsConnected(),
    temporaryDirectoryRemoved: profileRemoval?.status === "fulfilled" && !input.profileExists(),
  };
}

async function applyCdpNetworkControl(
  cdp: CDPSession,
  control: ChromiumNetworkFaultControl,
): Promise<void> {
  if (control.kind === "data-plane-reset") {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    return;
  }

  const offline =
    (control.kind === "link-state" && control.lifecycle === "apply") ||
    (control.kind === "data-plane-blackhole" && control.lifecycle === "apply");
  if (control.kind === "link-state" || control.kind === "data-plane-blackhole") {
    await cdp.send("Network.emulateNetworkConditions", {
      offline,
      latency: 0,
      downloadThroughput: offline ? 0 : -1,
      uploadThroughput: offline ? 0 : -1,
    });
    return;
  }

  if (control.kind !== "directional-impairment") {
    throw new Error(`Unsupported Chromium network control '${control.kind}'.`);
  }
  const enabled = control.lifecycle === "apply";
  const parameters = control.parameters;
  if (!parameters) throw new Error("Directional impairment requires network parameters.");
  const bytesPerSecond =
    parameters.bandwidthKbps === null ? -1 : (parameters.bandwidthKbps * 1_000) / 8;
  const sendNetworkConditions = cdp.send.bind(cdp) as (
    method: "Network.emulateNetworkConditions",
    parameters: Record<string, unknown>,
  ) => Promise<unknown>;
  await sendNetworkConditions("Network.emulateNetworkConditions", {
    offline: false,
    latency: enabled ? parameters.latencyMs : 0,
    downloadThroughput: enabled ? bytesPerSecond : -1,
    uploadThroughput: enabled ? bytesPerSecond : -1,
    // Chromium supports these experimental fields even though older protocol typings omit them.
    ...(enabled
      ? {
          packetLoss: parameters.lossPercent,
          packetQueueLength: 100,
          packetReordering: false,
        }
      : {}),
  });
}

export async function launchChromiumNetworkLabHarness(
  options: ChromiumNetworkLabHarnessOptions = {},
): Promise<ChromiumNetworkLabHarness> {
  const now = options.now ?? Date.now;
  const executablePath = options.executablePath ?? process.env.T3_NETWORK_LAB_CHROMIUM;
  if (!executablePath || !NodeFS.existsSync(executablePath)) {
    throw new Error(
      "A real Chromium executable is required via options.executablePath or T3_NETWORK_LAB_CHROMIUM.",
    );
  }

  const userDataDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-network-lab-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: true,
      args: ["--disable-background-networking", "--no-first-run"],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    const traffic: MutableTraffic = {
      bytesSent: 0,
      bytesReceived: 0,
      requestCount: 0,
      eventCount: 0,
    };
    const faultEvidence: Array<AppliedChromiumFault> = [];
    let closed = false;
    let cleanupResult:
      | { readonly browserDisconnected: boolean; readonly temporaryDirectoryRemoved: boolean }
      | undefined;

    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", (event) => {
      traffic.requestCount += 1;
      traffic.eventCount += 1;
      traffic.bytesSent +=
        payloadBytes(event.request.url) + payloadBytes(event.request.postData ?? "");
    });
    cdp.on("Network.loadingFinished", (event) => {
      traffic.eventCount += 1;
      traffic.bytesReceived += Math.max(0, Math.round(event.encodedDataLength));
    });
    cdp.on("Network.webSocketFrameSent", (event) => {
      traffic.eventCount += 1;
      traffic.bytesSent += payloadBytes(event.response.payloadData);
    });
    cdp.on("Network.webSocketFrameReceived", (event) => {
      traffic.eventCount += 1;
      traffic.bytesReceived += payloadBytes(event.response.payloadData);
    });

    return {
      page,
      userDataDir,
      get faultEvidence() {
        return faultEvidence;
      },
      traffic: () => ({ ...traffic }),
      applyFault: async (control, decisionToken) => {
        if (closed) throw new Error("Cannot apply a fault after Chromium cleanup.");
        if (!decisionToken) throw new Error("Fault application requires a decision token.");
        if (control.kind === "protocol-suppression") {
          if (!options.protocolControl) {
            throw new Error(
              "Protocol-suppression evidence requires the real server fixture control.",
            );
          }
          await options.protocolControl(control, decisionToken);
          faultEvidence.push({
            decisionToken,
            control,
            appliedAtMs: now(),
            mechanism: "external-protocol-suppression-adapter",
          });
          return { decisionToken, effectiveControl: control };
        }
        await applyCdpNetworkControl(cdp, control);
        faultEvidence.push({
          decisionToken,
          control,
          appliedAtMs: now(),
          mechanism: "chromium-cdp",
        });
        return { decisionToken, effectiveControl: control };
      },
      waitForVisible: async (selector, timeoutMs) => {
        const startedAt = now();
        await page.locator(selector).waitFor({ state: "visible", timeout: timeoutMs });
        return now() - startedAt;
      },
      close: async () => {
        if (cleanupResult) return cleanupResult;
        if (!closed) {
          closed = true;
          cleanupResult = await finalizeChromiumIsolation({
            closeContext: async () => context?.close(),
            removeProfile: () => NodeFSP.rm(userDataDir, { recursive: true, force: true }),
            browserIsConnected: () => context?.browser()?.isConnected() === true,
            profileExists: () => NodeFS.existsSync(userDataDir),
          });
        }
        return cleanupResult ?? { browserDisconnected: false, temporaryDirectoryRemoved: false };
      },
    };
  } catch (error) {
    const contextCleanup = await Promise.allSettled([context?.close()]);
    const directoryCleanup = await Promise.allSettled([
      NodeFSP.rm(userDataDir, { recursive: true, force: true }),
    ]);
    const cleanup = [...contextCleanup, ...directoryCleanup];
    const cleanupFailed = cleanup.some(({ status }) => status === "rejected");
    if (cleanupFailed || NodeFS.existsSync(userDataDir)) {
      // oxlint-disable-next-line preserve-caught-error -- AggregateError carries the original failure in both errors and cause.
      throw new AggregateError(
        [
          error,
          ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        ],
        "Chromium launch failed and its isolated profile could not be fully cleaned up.",
        { cause: error },
      );
    }
    throw error;
  }
}

export function makeChromiumProductionT3Driver(
  harness: ChromiumNetworkLabHarness,
  now: () => number = Date.now,
): ChromiumProductionT3Driver {
  return {
    navigate: async (url) => {
      await harness.page.goto(url, { waitUntil: "domcontentloaded" });
    },
    assertProductionSurface: async (selectors) => {
      await harness.page.locator(selectors.composer).waitFor({ state: "visible" });
      await harness.page.locator(selectors.cachedTimeline).first().waitFor({ state: "visible" });
    },
    cachedContentNonblank: async (selector) => {
      const content = await harness.page
        .locator(selector)
        .first()
        .innerText()
        .catch(() => "");
      return content.trim().length > 0;
    },
    submitComposer: async (input) => {
      const existingIds = await harness.page
        .locator(`${input.durableIntentSelector} [data-outbox-command-id]`)
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-outbox-command-id")));
      const startedAt = now();
      await harness.page.locator(input.composerSelector).fill(input.text);
      const submitControl = harness.page.locator(input.submitSelector).first();
      const submitLabel = await submitControl.getAttribute("aria-label");
      if (submitLabel !== "Save message for delivery") {
        throw new Error(
          `Offline acceptance sampling requires 'Save message for delivery', observed '${String(submitLabel)}'.`,
        );
      }
      await submitControl.click();
      const identityExclusions = existingIds
        .filter((id): id is string => id !== null)
        .map((id) => `:not([data-outbox-command-id=${JSON.stringify(id)}])`)
        .join("");
      const newIntent = harness.page
        .locator(`${input.durableIntentSelector} [data-outbox-command-id]${identityExclusions}`)
        .filter({ hasText: input.text })
        .first();
      await newIntent.waitFor({ state: "visible" });
      const commandId = await newIntent.getAttribute("data-outbox-command-id");
      if (!commandId || existingIds.includes(commandId)) {
        throw new Error(
          "The durable outbox did not expose a new command identity for this message.",
        );
      }
      return {
        localAcceptanceMs: now() - startedAt,
        commandId,
        text: input.text,
      } satisfies ProductionBrowserSubmissionEvidence;
    },
    waitForConnectionStatus: (selector, timeoutMs) => harness.waitForVisible(selector, timeoutMs),
    waitForRecovery: async (selector, timeoutMs) => {
      const startedAt = now();
      await harness.page.locator(selector).waitFor({ state: "hidden", timeout: timeoutMs });
      return now() - startedAt;
    },
    reload: async () => {
      await harness.page.reload({ waitUntil: "domcontentloaded" });
    },
    applyControl: harness.applyFault,
    traffic: harness.traffic,
    close: async () => {
      const cleanup = await harness.close();
      return {
        complete: cleanup.browserDisconnected && cleanup.temporaryDirectoryRemoved,
        details: JSON.stringify(cleanup),
      };
    },
  };
}
