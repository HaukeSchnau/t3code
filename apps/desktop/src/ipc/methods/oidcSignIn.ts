import { DesktopOidcSignInInputSchema, DesktopOidcSignInResultSchema } from "@t3tools/contracts";

import * as DesktopOidcSignIn from "../../app/DesktopOidcSignIn.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const signInWithOidc = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OIDC_SIGN_IN_CHANNEL,
  payload: DesktopOidcSignInInputSchema,
  result: DesktopOidcSignInResultSchema,
  handler: DesktopOidcSignIn.signInWithOidc,
});
