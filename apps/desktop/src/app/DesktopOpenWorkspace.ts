import type { DesktopOpenWorkspaceRequest } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "../ipc/channels.ts";

const OPEN_WORKSPACE_ACTION = "open";
const CODEX_DEEP_LINK_ACTION = "codex";
const CODEX_RESUME_ACTION = "resume";
const DESKTOP_WORKSPACE_DEEP_LINK_PROTOCOLS = new Set(["t3:", "t3code:", "t3code-dev:"]);

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

function resolveDeepLinkPathSegments(url: URL): readonly string[] {
  return url.pathname
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0);
}

export function parseDesktopOpenWorkspaceUrl(rawUrl: unknown): DesktopOpenWorkspaceRequest | null {
  if (typeof rawUrl !== "string") {
    return null;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (!DESKTOP_WORKSPACE_DEEP_LINK_PROTOCOLS.has(url.protocol)) {
    return null;
  }

  const action = resolveDeepLinkAction(url);

  if (action === OPEN_WORKSPACE_ACTION) {
    const cwd = url.searchParams.get("cwd")?.trim();
    if (!cwd) {
      return null;
    }

    return { type: "open-workspace", cwd };
  }

  if (action === CODEX_DEEP_LINK_ACTION) {
    const pathSegments = resolveDeepLinkPathSegments(url);
    const subaction =
      pathSegments[0] === CODEX_DEEP_LINK_ACTION ? pathSegments[1] : pathSegments[0];
    if (subaction !== CODEX_RESUME_ACTION) {
      return null;
    }

    const threadId = url.searchParams.get("threadId")?.trim();
    if (!threadId) {
      return null;
    }

    return { type: "codex-thread-resume", threadId };
  }

  return null;
}

export interface DesktopOpenWorkspaceShape {
  readonly dispatch: (
    request: DesktopOpenWorkspaceRequest,
  ) => Effect.Effect<void, never, ElectronWindow.ElectronWindow>;
  readonly dispatchUrl: (
    rawUrl: unknown,
  ) => Effect.Effect<boolean, never, ElectronWindow.ElectronWindow>;
  readonly consumePending: Effect.Effect<readonly DesktopOpenWorkspaceRequest[]>;
}

export class DesktopOpenWorkspace extends Context.Service<
  DesktopOpenWorkspace,
  DesktopOpenWorkspaceShape
>()("@t3tools/desktop/app/DesktopOpenWorkspace") {}

const make = Effect.gen(function* () {
  const bridgeReadyRef = yield* Ref.make(false);
  const pendingRequestsRef = yield* Ref.make<readonly DesktopOpenWorkspaceRequest[]>([]);

  const broadcast = Effect.fn("desktop.openWorkspace.broadcast")(function* (
    request: DesktopOpenWorkspaceRequest,
  ): Effect.fn.Return<void, never, ElectronWindow.ElectronWindow> {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    yield* electronWindow.sendAll(IpcChannels.OPEN_WORKSPACE_REQUEST_CHANNEL, request);
    const mainWindow = yield* electronWindow.currentMainOrFirst;
    if (Option.isSome(mainWindow)) {
      yield* electronWindow.reveal(mainWindow.value);
    }
  });

  const dispatch = Effect.fn("desktop.openWorkspace.dispatch")(function* (
    request: DesktopOpenWorkspaceRequest,
  ): Effect.fn.Return<void, never, ElectronWindow.ElectronWindow> {
    const bridgeReady = yield* Ref.get(bridgeReadyRef);
    if (!bridgeReady) {
      yield* Ref.update(pendingRequestsRef, (requests) => [...requests, request]);
      return;
    }

    yield* broadcast(request);
  });

  return DesktopOpenWorkspace.of({
    dispatch,
    dispatchUrl: (rawUrl) => {
      const request = parseDesktopOpenWorkspaceUrl(rawUrl);
      if (!request) {
        return Effect.succeed(false);
      }

      return dispatch(request).pipe(Effect.as(true));
    },
    consumePending: Effect.gen(function* () {
      yield* Ref.set(bridgeReadyRef, true);
      return yield* Ref.getAndSet(pendingRequestsRef, []);
    }),
  });
});

export const layer = Layer.effect(DesktopOpenWorkspace, make);
