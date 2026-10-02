import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationPlatform,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const OPEN_WORKSPACE_ACTION = "open";
const DESKTOP_WORKSPACE_DEEP_LINK_PROTOCOLS = new Set(["t3:", "t3code:", "t3code-dev:"]);
const isActivationPlatform = Schema.is(DesktopAppActivationPlatform);

const { logWarning } = makeComponentLogger("desktop-open-workspace");

function resolveDeepLinkAction(url: URL): string | null {
  const hostname = url.hostname.trim().toLowerCase();
  if (hostname.length > 0) {
    return hostname;
  }

  return (
    url.pathname
      .split("/")
      .map((segment) => segment.trim().toLowerCase())
      .find((segment) => segment.length > 0) ?? null
  );
}

/** Returns the workspace root of a `<scheme>://open?cwd=<path>` deeplink. */
export function parseDesktopOpenWorkspaceUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string") {
    return null;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (
    !DESKTOP_WORKSPACE_DEEP_LINK_PROTOCOLS.has(url.protocol) ||
    resolveDeepLinkAction(url) !== OPEN_WORKSPACE_ACTION
  ) {
    return null;
  }

  return url.searchParams.get("cwd")?.trim() || null;
}

export class DesktopOpenWorkspace extends Context.Service<
  DesktopOpenWorkspace,
  {
    /** Queues a workspace deeplink and returns true; returns false for any other URL. */
    readonly dispatchUrl: (rawUrl: unknown) => boolean;
    readonly take: Effect.Effect<string>;
  }
>()("@t3tools/desktop/app/DesktopOpenWorkspace") {}

// Deeplinks can arrive before Electron is ready, so this queue lives in the
// pre-ready Clerk context and the application layer drains it.
export const layer = Layer.effect(
  DesktopOpenWorkspace,
  Effect.gen(function* () {
    const workspaceRoots = yield* Queue.unbounded<string>();
    return DesktopOpenWorkspace.of({
      // Electron event handlers decide synchronously whether they handled a URL.
      dispatchUrl: (rawUrl) => {
        const workspaceRoot = parseDesktopOpenWorkspaceUrl(rawUrl);
        return workspaceRoot !== null && Queue.offerUnsafe(workspaceRoots, workspaceRoot);
      },
      take: Queue.take(workspaceRoots),
    });
  }),
);

/** Opens queued deeplinks through the same activation broker as `t3 app <path>`. */
export const layerAppActivationDelivery = Layer.effectDiscard(
  Effect.gen(function* () {
    const openWorkspace = yield* DesktopOpenWorkspace;
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    const electronApp = yield* ElectronApp.ElectronApp;
    const crypto = yield* Crypto.Crypto;
    const { platform } = yield* DesktopEnvironment.DesktopEnvironment;
    if (!isActivationPlatform(platform)) return;

    const open = (workspaceRoot: string) =>
      crypto.randomUUIDv4.pipe(
        Effect.flatMap((requestId) =>
          activation.request({
            version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
            requestId,
            type: "open-workspace",
            workspaceRoot,
            platform,
          }),
        ),
        Effect.flatMap((response) =>
          response.ok
            ? Effect.void
            : logWarning("could not open the deeplinked workspace", {
                workspaceRoot,
                code: response.code,
                message: response.message,
              }),
        ),
        Effect.catchCause((cause) =>
          logWarning("could not open the deeplinked workspace", { workspaceRoot, cause }),
        ),
      );

    yield* electronApp.whenReady.pipe(
      Effect.andThen(Effect.forever(Effect.flatMap(openWorkspace.take, open))),
      Effect.catchCause((cause) => logWarning("stopped opening deeplinked workspaces", { cause })),
      Effect.forkScoped,
    );
  }),
);
