// @effect-diagnostics nodeBuiltinImport:off -- the cgroup fixture lives in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  parseDarwinMemoryPressureLevel,
  parseMemoryPressure,
  parseSwap,
  readAgentSlice,
} from "./HostPressure.ts";

describe("parseMemoryPressure", () => {
  it("reads the some line's avg10 and avg60", () => {
    // srv-2 on 2026-11-16, while systemd-oomd killed agents.
    expect(
      parseMemoryPressure(
        "some avg10=91.62 avg60=78.04 avg300=55.10 total=912345678\n" +
          "full avg10=88.20 avg60=70.31 avg300=49.97 total=812345678\n",
      ),
    ).toEqual({ someAvg10: 91.62, someAvg60: 78.04 });
  });

  it("is absent without PSI", () => {
    expect(parseMemoryPressure("")).toBeUndefined();
    expect(parseMemoryPressure("full avg10=1.00 avg60=1.00 avg300=0.00 total=1\n")).toBeUndefined();
  });
});

describe("parseSwap", () => {
  it("reads swap in bytes, and keeps a swapless host's zero", () => {
    const meminfo = (total: number, free: number) =>
      `MemTotal:       32788240 kB\nMemAvailable:   11957064 kB\n` +
      `SwapTotal:      ${total} kB\nSwapFree:       ${free} kB\n`;
    expect(parseSwap(meminfo(16393724, 10471112))).toEqual({
      swapTotalBytes: 16393724 * 1024,
      swapFreeBytes: 10471112 * 1024,
    });
    expect(parseSwap(meminfo(0, 0))).toEqual({ swapTotalBytes: 0, swapFreeBytes: 0 });
    expect(parseSwap("MemTotal:       32788240 kB\n")).toEqual({});
  });
});

describe("parseDarwinMemoryPressureLevel", () => {
  it("maps the kernel's levels and nothing else", () => {
    expect(["1\n", "2\n", "4\n", "", "3"].map(parseDarwinMemoryPressureLevel)).toEqual([
      "normal",
      "warning",
      "critical",
      undefined,
      undefined,
    ]);
  });
});

describe("readAgentSlice", () => {
  const withSlice = (files: Record<string, string>, scopes: ReadonlyArray<string>) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-slice-"));
    for (const [file, content] of Object.entries(files)) {
      NodeFS.writeFileSync(NodePath.join(root, file), content);
    }
    for (const scope of scopes) NodeFS.mkdirSync(NodePath.join(root, scope), { recursive: true });
    return root;
  };

  it.effect("counts agent scopes in the slice and its per-server slices", () =>
    Effect.gen(function* () {
      const root = withSlice({ "memory.current": "12530712576\n", "memory.max": "29280190464\n" }, [
        "t3code-claude-8236af65.scope",
        "app-t3code-agents-7726cddc2d66.slice/t3code-codex-5f367bdd.scope",
        "app-t3code-agents-7726cddc2d66.slice/t3code-claude-e396511f.scope",
        "app-t3code-agents-7726cddc2d66.slice/t3code-terminal-0a1b2c3d.scope",
        "app-t3code-agents-cb94db26343b.slice/t3code-watch-0a1b2c3d.scope",
        "app-t3code-agents-cb94db26343b.slice/t3code-preview-browser-0a1b2c3d.scope",
        "app-t3code-agents-cb94db26343b.slice/t3code-codex-75242413.scope",
      ]);
      expect(yield* readAgentSlice(root)).toEqual({
        running: 4,
        memoryCurrentBytes: 12530712576,
        memoryMaxBytes: 29280190464,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves out an unlimited slice's max, and a slice it cannot read", () =>
    Effect.gen(function* () {
      const unlimited = withSlice({ "memory.current": "4096\n", "memory.max": "max\n" }, []);
      expect(yield* readAgentSlice(unlimited)).toEqual({ running: 0, memoryCurrentBytes: 4096 });
      expect(yield* readAgentSlice(NodePath.join(unlimited, "missing"))).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
