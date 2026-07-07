import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { CodexThreadForkInput, CodexThreadForkResult, ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeCodexThreadForkInput = Schema.decodeUnknownSync(CodexThreadForkInput);
const decodeCodexThreadForkResult = Schema.decodeUnknownSync(CodexThreadForkResult);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });
});

describe("CodexThreadFork", () => {
  it("decodes new workspace fork requests", () => {
    const parsed = decodeCodexThreadForkInput({
      threadId: "thread-source",
      lastTurnId: "turn-1",
      sourceMessageId: "message-1",
      workspace: { mode: "new", kind: "directory-copy" },
    });

    expect(parsed.workspace).toEqual({ mode: "new", kind: "directory-copy" });
  });

  it("rejects non-copy workspace kinds for Codex fork requests", () => {
    expect(() =>
      decodeCodexThreadForkInput({
        threadId: "thread-source",
        workspace: { mode: "new", kind: "git-detached" },
      }),
    ).toThrow();
  });

  it("decodes fork results with destination workspace metadata", () => {
    const parsed = decodeCodexThreadForkResult({
      threadId: "thread-destination",
      projectId: "project-1",
      sourceThreadId: "thread-source",
      providerThreadId: "codex-thread-destination",
      importedMessageCount: 4,
      workspaceId: "workspace:thread-destination",
    });

    expect(parsed.workspaceId).toBe("workspace:thread-destination");
  });
});
