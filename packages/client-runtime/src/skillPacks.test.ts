import {
  ProviderDriverKind,
  SkillId,
  SkillPackId,
  type SkillPackCatalog,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeSkillPackSkills,
  formatSkillPackSelectionLabel,
  formatSkillPackSelectionSummary,
  resolveEffectiveSkills,
  resolveSkillPackProviderWarning,
  resolveSkillPackSelection,
  toggleSkillPackId,
} from "./skillPacks.ts";

const id = SkillPackId.make;
const skill = SkillId.make;

const catalog: SkillPackCatalog = {
  version: 1,
  coreSkillIds: [skill("frontend-design"), skill("unslop")],
  skills: [
    { id: skill("frontend-design"), displayName: "Frontend design" },
    { id: skill("unslop"), displayName: "Unslop" },
    { id: skill("dataviz"), displayName: "Data viz" },
    { id: skill("playwriter"), displayName: "Playwriter" },
    { id: skill("nix-infra"), displayName: "Nix infra" },
  ],
  packs: [
    {
      id: id("web-craft"),
      displayName: "Web craft",
      description: "Frontend polish",
      skillIds: [skill("frontend-design"), skill("dataviz"), skill("playwriter")],
    },
    {
      id: id("browser-qa"),
      displayName: "Browser QA",
      description: "Drive browsers",
      skillIds: [skill("playwriter")],
    },
    {
      id: id("infra"),
      displayName: "Infra",
      description: "NixOS fleet work",
      skillIds: [skill("nix-infra")],
    },
  ],
  profiles: [
    {
      id: id("frontend"),
      displayName: "Frontend",
      description: "Web craft plus browser QA",
      packIds: [id("browser-qa"), id("web-craft")],
    },
  ],
};

describe("resolveSkillPackSelection", () => {
  it("reads as core when neither project nor thread selects packs", () => {
    const selection = resolveSkillPackSelection({
      catalog,
      projectDefaultPackIds: undefined,
      threadScope: null,
    });
    expect(selection).toMatchObject({
      packIds: [],
      source: "core",
      isProjectDefault: true,
      state: "ready",
      profile: null,
    });
    expect(formatSkillPackSelectionLabel(catalog, selection)).toBe("core");
  });

  it("inherits the project default when the thread has no scope", () => {
    const selection = resolveSkillPackSelection({
      catalog,
      projectDefaultPackIds: [id("infra")],
      threadScope: undefined,
    });
    expect(selection.source).toBe("project");
    expect(selection.packIds).toEqual([id("infra")]);
    expect(formatSkillPackSelectionLabel(catalog, selection)).toBe("Infra");
  });

  it("treats a thread scope equal to the project default as not overridden", () => {
    const selection = resolveSkillPackSelection({
      catalog,
      projectDefaultPackIds: [id("web-craft"), id("browser-qa")],
      threadScope: {
        version: 2,
        appliedVersion: 1,
        packIds: [id("browser-qa"), id("web-craft")],
        state: "pending",
      },
    });
    expect(selection.source).toBe("project");
    expect(selection.isProjectDefault).toBe(true);
    expect(selection.state).toBe("pending");
    expect(selection.profile?.id).toBe(id("frontend"));
    expect(formatSkillPackSelectionSummary(catalog, selection)).toBe(
      "Skills: Frontend · applies on the next turn",
    );
  });

  it("marks a differing thread scope as an override and surfaces degraded issues", () => {
    const selection = resolveSkillPackSelection({
      catalog,
      projectDefaultPackIds: [],
      threadScope: {
        version: 1,
        appliedVersion: 1,
        packIds: [id("infra"), id("unknown-pack")],
        state: "degraded",
        issue: "plugin path missing",
      },
    });
    expect(selection.source).toBe("thread");
    expect(selection.packIds).toEqual([id("infra")]);
    expect(formatSkillPackSelectionSummary(catalog, selection)).toBe(
      "Skills: Infra · plugin path missing",
    );
  });

  it("uses draft pack ids for unstarted threads and counts multiple packs", () => {
    const selection = resolveSkillPackSelection({
      catalog,
      projectDefaultPackIds: [],
      draftPackIds: [id("infra"), id("web-craft")],
    });
    expect(selection.source).toBe("thread");
    expect(selection.state).toBe("ready");
    expect(formatSkillPackSelectionLabel(catalog, selection)).toBe("2 packs");
  });
});

describe("toggleSkillPackId", () => {
  it("adds and removes packs while keeping catalog order", () => {
    const added = toggleSkillPackId(catalog, [id("infra")], id("web-craft"));
    expect(added).toEqual([id("web-craft"), id("infra")]);
    expect(toggleSkillPackId(catalog, added, id("infra"))).toEqual([id("web-craft")]);
  });
});

describe("describeSkillPackSkills", () => {
  it("flags skills already provided by core or an earlier selected pack", () => {
    const rows = describeSkillPackSkills(catalog, catalog.packs[1]!, [
      id("web-craft"),
      id("browser-qa"),
    ]);
    expect(rows).toEqual([
      {
        skill: { id: skill("playwriter"), displayName: "Playwriter" },
        providedBy: id("web-craft"),
      },
    ]);
    const webCraft = describeSkillPackSkills(catalog, catalog.packs[0]!, [id("web-craft")]);
    expect(webCraft.map((row) => row.providedBy)).toEqual(["core", null, null]);
  });
});

describe("resolveEffectiveSkills", () => {
  it("lists core first and never repeats a skill", () => {
    const skills = resolveEffectiveSkills(catalog, [id("browser-qa"), id("web-craft")]);
    expect(skills.map((entry) => entry.id)).toEqual([
      skill("frontend-design"),
      skill("unslop"),
      skill("dataviz"),
      skill("playwriter"),
    ]);
  });
});

describe("resolveSkillPackProviderWarning", () => {
  it("only warns for unsupported providers with non-core packs selected", () => {
    const opencode = { driver: ProviderDriverKind.make("opencode") };
    expect(resolveSkillPackProviderWarning({ provider: opencode, packIds: [] })).toBeNull();
    expect(resolveSkillPackProviderWarning({ provider: opencode, packIds: [id("infra")] })).toMatch(
      /cannot load skill packs/,
    );
    expect(
      resolveSkillPackProviderWarning({
        provider: { ...opencode, skillScopeInjection: "supported" },
        packIds: [id("infra")],
      }),
    ).toBeNull();
    expect(
      resolveSkillPackProviderWarning({
        provider: { driver: ProviderDriverKind.make("claudeAgent") },
        packIds: [id("infra")],
      }),
    ).toBeNull();
  });
});
