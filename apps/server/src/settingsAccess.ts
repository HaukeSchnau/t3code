import type { ServerSettingsError, ServerSettingsPatch } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { remoteSshDeviceHosts } from "./device/localSshDeviceHost.ts";
import * as ServerSettings from "./serverSettings.ts";

// `t3 settings get` shows secret references as they are, so a patch built from it can send them back.
const settingsClient = { secretReferences: true } as const;

export const readSettingsForClient = Effect.fn("settingsAccess.read")(function* () {
  const service = yield* ServerSettings.ServerSettingsService;
  return ServerSettings.redactServerSettingsForClient(yield* service.getSettings, settingsClient);
});

// Keep in step with the server.updateSettings RPC handler in ws.ts, which the UI calls.
export const updateSettingsForClient = Effect.fn("settingsAccess.update")(function* (
  patch: ServerSettingsPatch,
) {
  const service = yield* ServerSettings.ServerSettingsService;
  const deviceHosts = patch.deviceHosts
    ? yield* remoteSshDeviceHosts(patch.deviceHosts)
    : undefined;
  const settings = yield* service.updateSettings({
    ...patch,
    ...(deviceHosts ? { deviceHosts } : {}),
  });
  return ServerSettings.redactServerSettingsForClient(settings, settingsClient);
});

export function settingsErrorMessage(error: ServerSettingsError): string {
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause === undefined || cause.length === 0 ? error.message : `${error.message}\n${cause}`;
}
