import {
  DesktopDictationDeliverRequest,
  DesktopDictationDelivery,
  DesktopDictationPill,
  DesktopDictationPrepareRequest,
  DesktopDictationStatus,
  DesktopDictationTarget,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopDictation from "../../dictation/DesktopDictation.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class DictationIpcUnauthorizedSenderError extends Schema.TaggedError<DictationIpcUnauthorizedSenderError>()(
  "DictationIpcUnauthorizedSenderError",
  {},
) {
  override get message(): string {
    return "Dictation request was rejected.";
  }
}

// Reading another app's field and typing into it is reserved for the app's own window.
const ensureMainWindowSender = Effect.fn("desktop.ipc.dictation.ensureMainWindowSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const main = yield* (yield* ElectronWindow.ElectronWindow).main;
  if (event === undefined || Option.isNone(main) || main.value.webContents.id !== event.sender.id)
    return yield* new DictationIpcUnauthorizedSenderError();
});

export const getDictationStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_DICTATION_STATUS_CHANNEL,
  payload: Schema.Void,
  result: DesktopDictationStatus,
  handler: Effect.fn("desktop.ipc.dictation.getStatus")(function* () {
    return yield* (yield* DesktopDictation.DesktopDictation).status;
  }),
});

export const prepareDictation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREPARE_DICTATION_CHANNEL,
  payload: DesktopDictationPrepareRequest,
  result: DesktopDictationTarget,
  handler: Effect.fn("desktop.ipc.dictation.prepare")(function* (request, event) {
    yield* ensureMainWindowSender(event);
    return yield* (yield* DesktopDictation.DesktopDictation).prepare(request);
  }),
});

export const deliverDictation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DELIVER_DICTATION_CHANNEL,
  payload: DesktopDictationDeliverRequest,
  result: DesktopDictationDelivery,
  handler: Effect.fn("desktop.ipc.dictation.deliver")(function* (request, event) {
    yield* ensureMainWindowSender(event);
    return yield* (yield* DesktopDictation.DesktopDictation).deliver(request);
  }),
});

export const requestDictationAccessibility = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REQUEST_DICTATION_ACCESSIBILITY_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.dictation.requestAccessibility")(function* (_, event) {
    yield* ensureMainWindowSender(event);
    yield* (yield* DesktopDictation.DesktopDictation).requestAccessibility;
  }),
});

export const setDictationPill = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_DICTATION_PILL_CHANNEL,
  payload: Schema.NullOr(DesktopDictationPill),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.dictation.setPill")(function* (pill, event) {
    yield* ensureMainWindowSender(event);
    yield* (yield* DesktopDictation.DesktopDictation).setPill(pill);
  }),
});
