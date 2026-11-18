// @effect-diagnostics globalTimers:off -- Helper timeouts run at child-process callback boundaries outside Effect fibers.
// @effect-diagnostics nodeBuiltinImport:off -- This macOS platform boundary runs short osascript helpers with Node.

import * as NodeChildProcess from "node:child_process";

import type { DesktopDictationDelivery, DesktopDictationStatus } from "@t3tools/contracts";

const HELPER_TIMEOUT_MS = 4_000;

// Shared by both helpers: pasteboard snapshot and restore, and synthetic Command shortcuts.
// Posting keys needs the Accessibility grant T3 holds; osascript inherits it as T3's child.
const PASTEBOARD_SCRIPT = `
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("CoreGraphics");
ObjC.import("ApplicationServices");
// frontmostApplication only updates when the run loop runs, so run it briefly before each read.
function frontPid() {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.01));
  return $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
}
function snapshot(pb) {
  const items = [];
  const all = pb.pasteboardItems;
  for (let i = 0; i < all.count; i++) {
    const item = all.objectAtIndex(i);
    const entries = [];
    for (let j = 0; j < item.types.count; j++) {
      const type = item.types.objectAtIndex(j);
      const data = item.dataForType(type);
      if (!data.isNil()) entries.push([type, data]);
    }
    items.push(entries);
  }
  return items;
}
function restore(pb, items) {
  pb.clearContents;
  const objects = $.NSMutableArray.array;
  for (const entries of items) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const [type, data] of entries) item.setDataForType(data, type);
    objects.addObject(item);
  }
  if (objects.count > 0) pb.writeObjects(objects);
}
function command(keyCode) {
  for (const down of [true, false]) {
    const event = $.CGEventCreateKeyboardEvent(null, keyCode, down);
    $.CGEventSetFlags(event, 0x100000);
    $.CGEventPost(0, event);
  }
}
function attribute(element, name) {
  const out = Ref();
  if ($.AXUIElementCopyAttributeValue(element, $(name), out) !== 0) return null;
  return out[0];
}
function text(element, name) {
  try {
    const value = attribute(element, name);
    if (!value) return null;
    const string = ObjC.castRefToObject(value);
    return typeof string.js === "string" ? string.js : null;
  } catch (error) {
    return null;
  }
}
// Password fields report a secure subrole. Nothing is read from them or pasted into them.
function isSecure(pid) {
  const focused = attribute($.AXUIElementCreateApplication(pid), "AXFocusedUIElement");
  return Boolean(focused) && text(focused, "AXSubrole") === "AXSecureTextField";
}
function stdin() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  return $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
}
`;

// The focused element's text, through Accessibility. Apps that expose no text return none.
const READ_SCRIPT = `${PASTEBOARD_SCRIPT}
function run(argv) {
  const pid = Number(argv[0]);
  const wantField = argv[1] === "1";
  const wantSelection = argv[2] === "1";
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  const result = { front: front.processIdentifier, app: front.localizedName.js, value: null, selected: null };
  if (result.front !== pid || !$.AXIsProcessTrusted()) return JSON.stringify(result);
  const app = $.AXUIElementCreateApplication(pid);
  if (isSecure(pid)) return JSON.stringify(result);
  const focused = attribute(app, "AXFocusedUIElement");
  if (focused) {
    if (wantField) result.value = text(focused, "AXValue");
    if (wantField || wantSelection) result.selected = text(focused, "AXSelectedText");
  }
  // Shortcuts go to whichever app is in front, so check again right before sending one.
  if (wantSelection && !result.selected && frontPid() === pid) {
    const pb = $.NSPasteboard.generalPasteboard;
    const saved = snapshot(pb);
    const before = pb.changeCount;
    command(8);
    for (let waited = 0; waited < 0.4 && pb.changeCount === before; waited += 0.05) delay(0.05);
    if (pb.changeCount !== before) {
      const copied = pb.stringForType($("public.utf8-plain-text"));
      result.selected = copied.isNil() ? null : copied.js;
      restore(pb, saved);
    }
  }
  return JSON.stringify(result);
}`;

// Pastes when the press's app is still in front, then restores the clipboard unless someone
// copied in between. Otherwise the text stays on the clipboard for the person to paste.
const PASTE_SCRIPT = `${PASTEBOARD_SCRIPT}
function run(argv) {
  const pid = Number(argv[0]);
  const value = stdin();
  const pb = $.NSPasteboard.generalPasteboard;
  const paste = frontPid() === pid && $.AXIsProcessTrusted();
  const saved = paste ? snapshot(pb) : null;
  pb.clearContents;
  pb.setStringForType($(value), $("public.utf8-plain-text"));
  if (!paste) return "copied";
  pb.setStringForType($(""), $("org.nspasteboard.TransientType"));
  if (frontPid() !== pid || isSecure(pid)) return "copied";
  const written = pb.changeCount;
  command(9);
  delay(0.6);
  if (pb.changeCount === written) restore(pb, saved);
  return "pasted";
}`;

function runOsascript(script: string, args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", script, ...args],
      { timeout: HELPER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
    child.stdin?.end(input ?? "");
  });
}

export type MacDictationField = {
  readonly front: number;
  readonly app: string | null;
  readonly value: string | null;
  readonly selected: string | null;
};

export async function readMacDictationField(
  pid: number,
  options: { readonly field: boolean; readonly selection: boolean },
): Promise<MacDictationField | null> {
  try {
    const output = await runOsascript(READ_SCRIPT, [
      String(pid),
      options.field ? "1" : "0",
      options.selection ? "1" : "0",
    ]);
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed !== "object" || parsed === null) return null;
    const read = (key: string) => {
      const value = (parsed as Record<string, unknown>)[key];
      return typeof value === "string" ? value : null;
    };
    const front = (parsed as Record<string, unknown>).front;
    return {
      front: typeof front === "number" ? front : -1,
      app: read("app"),
      value: read("value"),
      selected: read("selected"),
    };
  } catch {
    return null;
  }
}

export async function pasteMacDictation(
  pid: number,
  text: string,
): Promise<DesktopDictationDelivery> {
  try {
    const result = await runOsascript(PASTE_SCRIPT, [String(pid)], text);
    return result === "pasted" || result === "copied" ? result : "failed";
  } catch {
    return "failed";
  }
}

const GLOBE_KEY_ACTIONS: Record<string, DesktopDictationStatus["globeKey"]> = {
  "0": "none",
  "1": "input-source",
  "2": "emoji",
  "3": "dictation",
};

export function readMacGlobeKeyAction(): Promise<DesktopDictationStatus["globeKey"]> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "/usr/bin/defaults",
      ["read", "com.apple.HIToolbox", "AppleFnUsageType"],
      { timeout: HELPER_TIMEOUT_MS },
      (error, stdout) => resolve(error ? null : (GLOBE_KEY_ACTIONS[stdout.trim()] ?? null)),
    );
  });
}

/** Places the press's text in its field as the cursor context: the selection when one is found. */
export function dictationDraftFromField(field: MacDictationField) {
  const value = field.value ?? "";
  const selected = field.selected ?? "";
  if (selected) {
    const start = value.indexOf(selected);
    if (start >= 0 && value.indexOf(selected, start + 1) < 0)
      return { text: value, selection: { start, end: start + selected.length } };
    return { text: selected, selection: { start: 0, end: selected.length } };
  }
  if (!value) return null;
  // Without a readable caret, the end of the field is the likeliest place someone is writing.
  return { text: value, selection: { start: value.length, end: value.length } };
}
