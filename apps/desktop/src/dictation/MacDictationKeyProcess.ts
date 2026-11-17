// @effect-diagnostics nodeBuiltinImport:off -- This macOS platform boundary spawns the native key poller with Node.

import * as NodeChildProcess from "node:child_process";

import type { DictationKey } from "@t3tools/contracts";

import type { DictationModifiers } from "./dictationPress.ts";

export type DictationKeyLine =
  | { readonly type: "down"; readonly frontPid: number; readonly modifiers: DictationModifiers }
  | { readonly type: "modifiers"; readonly modifiers: DictationModifiers }
  | { readonly type: "key" | "up" | "escape" };

// Hardware state needs no Input Monitoring grant. Chord keys are scanned, since the last-event clock
// only updates twice a second. Arrow keys raise Fn with the keypad bit. frontmostApplication only
// updates when the run loop runs, which delay() never does, so each press runs it briefly first.
const POLLER_SCRIPT = `
ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
ObjC.import("CoreGraphics");
ObjC.import("unistd");
function run(argv) {
  const trigger = argv[0];
  const FN = 0x800000, KEYPAD = 0x200000, SHIFT = 0x20000, CONTROL = 0x40000;
  const bit = trigger === "fn" ? FN : trigger === "right-option" ? 0x40 : 0x10;
  const modifiers = (flags) => ((flags & SHIFT) ? "s" : "") + ((flags & CONTROL) ? "c" : "") || "-";
  let down = false, sent = "", chord = false, escape = false;
  const workspace = $.NSWorkspace.sharedWorkspace;
  workspace.frontmostApplication;
  console.log("ready");
  while ($.getppid() !== 1) {
    const flags = Number($.CGEventSourceFlagsState(0));
    const pressed = (flags & bit) !== 0 && (down || trigger !== "fn" || (flags & KEYPAD) === 0);
    if (pressed) {
      const current = modifiers(flags);
      if (!down) {
        down = true;
        chord = false;
        sent = current;
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.02));
        console.log("down " + workspace.frontmostApplication.processIdentifier + " " + current);
      } else if (current !== sent) {
        sent = current;
        console.log("modifiers " + current);
      }
      for (let code = 0; !chord && code < 128; code++) {
        if (code >= 54 && code <= 63) continue;
        if ($.CGEventSourceKeyState(0, code)) {
          chord = true;
          console.log("key");
        }
      }
    } else if (down) {
      down = false;
      console.log("up");
    }
    const esc = $.CGEventSourceKeyState(0, 53);
    if (esc && !escape) console.log("escape");
    escape = esc;
    delay(0.03);
  }
  return "orphaned";
}`;

function parseModifiers(token: string | undefined): DictationModifiers {
  return { shift: token?.includes("s") ?? false, control: token?.includes("c") ?? false };
}

function parseDictationKeyLine(line: string): DictationKeyLine | null {
  const [type, first, second] = line.trim().split(" ");
  switch (type) {
    case "down": {
      const frontPid = Number(first);
      return Number.isInteger(frontPid)
        ? { type, frontPid, modifiers: parseModifiers(second) }
        : null;
    }
    case "modifiers":
      return { type, modifiers: parseModifiers(first) };
    case "key":
    case "up":
    case "escape":
      return { type };
    default:
      return null;
  }
}

export function startMacDictationKeyProcess(
  trigger: Exclude<DictationKey, "off">,
  onLine: (line: DictationKeyLine) => void,
  onFailure: (error: Error) => void,
): Promise<() => void> {
  const poller = NodeChildProcess.spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", POLLER_SCRIPT, trigger],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let buffered = "";
    const stop = () => {
      if (stopped) return;
      stopped = true;
      poller.kill();
    };
    const fail = (error: Error) => {
      if (stopped) return;
      if (settled) {
        stop();
        onFailure(error);
        return;
      }
      settled = true;
      stop();
      reject(error);
    };

    poller.stderr.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() === "ready" && !settled) {
          settled = true;
          resolve(stop);
          continue;
        }
        const parsed = parseDictationKeyLine(line);
        if (!parsed || !settled || stopped) continue;
        try {
          onLine(parsed);
        } catch {}
      }
    });
    poller.once("error", fail);
    poller.once("exit", (code) => {
      fail(new Error(`Dictation key helper exited with code ${code}`));
    });
  });
}
