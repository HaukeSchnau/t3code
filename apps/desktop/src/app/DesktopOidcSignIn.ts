import type { DesktopOidcSignInResult } from "@t3tools/contracts";
import { buildOidcSignInUrl, readOidcSignInResult } from "@t3tools/shared/remote";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Electron from "electron";

// Servers accept `t3code://` returns for mobile already. The window catches the redirect before
// it leaves, so the result never reaches the OS handler that would open it as an app link.
const RETURN_TO = "t3code://oidc";
// A provider that keeps a session in cookies then signs a later silent attempt in too.
const PARTITION = "persist:oidc-sign-in";
const SILENT_TIMEOUT = Duration.seconds(30);
// The server forgets a pending sign-in after 10 minutes.
const INTERACTIVE_TIMEOUT = Duration.minutes(10);
const NAVIGATION_ABORTED = -3;

export const signInWithOidc = Effect.fn("DesktopOidcSignIn.signInWithOidc")(function* (input: {
  readonly origin: string;
  readonly prompt?: "none";
}) {
  const url = URL.canParse(input.origin) ? new URL(input.origin) : null;
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    return { _tag: "Failed", error: "sign_in_failed" } satisfies DesktopOidcSignInResult;
  }
  const origin = url.origin;
  const random = yield* SecureRandom.SecureRandom;
  const clientState = Base64Url.encode(yield* random.randomBytes(24));
  const silent = input.prompt === "none";
  const startUrl = buildOidcSignInUrl(origin, {
    returnTo: RETURN_TO,
    clientState,
    ...(silent ? { prompt: "none" as const } : {}),
  });

  return yield* Effect.callback<DesktopOidcSignInResult>((resume) => {
    const window = new Electron.BrowserWindow({
      width: 520,
      height: 720,
      show: !silent,
      autoHideMenuBar: true,
      title: origin,
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    // A sign-in needs no permission, and an "openExternal" grant would let a page launch apps.
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    window.webContents.session.setPermissionCheckHandler(() => false);
    let settled = false;
    const close = () => {
      settled = true;
      if (!window.isDestroyed()) window.destroy();
    };
    const finish = (result: DesktopOidcSignInResult) => {
      if (settled) return;
      close();
      resume(Effect.succeed(result));
    };
    const intercept = (event: Electron.Event, target: string) => {
      if (!target.startsWith(`${RETURN_TO}?`) && !target.startsWith(`${RETURN_TO}#`)) return;
      event.preventDefault();
      finish(readOidcSignInResult(new URL(target), { origin, clientState }));
    };
    window.webContents.on("will-redirect", intercept);
    window.webContents.on("will-navigate", intercept);
    // A provider that refuses a silent attempt may show an error page instead of returning.
    window.webContents.on("did-navigate", (_event, _url, httpResponseCode) => {
      if (silent && httpResponseCode >= 400) finish({ _tag: "Failed", error: "sign_in_failed" });
    });
    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, _description, _validatedUrl, isMainFrame) => {
        if (isMainFrame && errorCode !== NAVIGATION_ABORTED) {
          finish({ _tag: "Failed", error: "unavailable" });
        }
      },
    );
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.once("closed", () => finish({ _tag: "Cancelled" }));
    // A redirect the window caught rejects the load; its result is already settled.
    window.loadURL(startUrl).catch(() => {});
    return Effect.sync(close);
  }).pipe(
    Effect.timeoutOrElse({
      duration: silent ? SILENT_TIMEOUT : INTERACTIVE_TIMEOUT,
      orElse: () =>
        Effect.succeed<DesktopOidcSignInResult>(
          silent ? { _tag: "Failed", error: "timeout" } : { _tag: "Cancelled" },
        ),
    }),
  );
});
