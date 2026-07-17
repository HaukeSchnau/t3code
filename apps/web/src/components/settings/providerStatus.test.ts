import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ServerProviderVersionAdvisory } from "@t3tools/contracts";

import { getProviderVersionAdvisoryPresentation } from "./providerStatus";

const updateAdvisory: ServerProviderVersionAdvisory = {
  status: "behind_latest",
  currentVersion: "2.1.201",
  latestVersion: "2.1.211",
  updateCommand: "npm install -g @anthropic-ai/claude-code@latest",
  canUpdate: true,
  checkedAt: "2026-07-17T00:00:00.000Z",
  message: "Update available.",
};

describe("provider status presentation", () => {
  it("hides self-update instructions for the externally managed Claudex wrapper", () => {
    expect(
      getProviderVersionAdvisoryPresentation(updateAdvisory, ProviderInstanceId.make("claudex")),
    ).toBeNull();
  });

  it("keeps update instructions for ordinary provider instances", () => {
    expect(
      getProviderVersionAdvisoryPresentation(
        updateAdvisory,
        ProviderInstanceId.make("claudeAgent"),
      ),
    ).toMatchObject({
      updateCommand: "npm install -g @anthropic-ai/claude-code@latest",
    });
  });
});
