import { SkillId, SkillPackId, type SkillPackCatalog } from "@t3tools/contracts";
import { resolveSkillPackSelection } from "@t3tools/client-runtime/skillPacks";
import { describe, expect, it } from "vite-plus/test";

import { buildSkillPacksSheetRows, skillPacksRowValue } from "./skill-packs-session";

const catalog: SkillPackCatalog = {
  version: 1,
  coreSkillIds: [SkillId.make("frontend-design")],
  skills: [
    { id: SkillId.make("frontend-design"), displayName: "Frontend design" },
    { id: SkillId.make("dataviz"), displayName: "Data viz" },
  ],
  packs: [
    {
      id: SkillPackId.make("web-craft"),
      displayName: "Web craft",
      description: "Frontend polish",
      skillIds: [SkillId.make("frontend-design"), SkillId.make("dataviz")],
    },
  ],
  profiles: [
    {
      id: SkillPackId.make("frontend"),
      displayName: "Frontend",
      description: "Web craft",
      packIds: [SkillPackId.make("web-craft")],
    },
  ],
};

describe("skill packs sheet", () => {
  it("labels the row with the state and lists resolved skills with repeats", () => {
    const selection = resolveSkillPackSelection({
      catalog,
      projectDefaultPackIds: [],
      threadScope: {
        version: 1,
        appliedVersion: 0,
        packIds: [SkillPackId.make("web-craft")],
        state: "pending",
      },
    });
    expect(skillPacksRowValue({ catalog, selection })).toBe("Frontend · pending");

    const rows = buildSkillPacksSheetRows({ catalog, selection, providerWarning: null });
    expect(rows.profiles).toEqual([expect.objectContaining({ id: "frontend", selected: true })]);
    expect(rows.packs).toEqual([expect.objectContaining({ id: "web-craft", selected: true })]);
    expect(rows.details).toEqual([
      "Core: Frontend design",
      "Web craft: Frontend design (already in core), Data viz",
      "2 skills in total",
    ]);
    expect(rows.notices).toEqual(["Applies on the next turn."]);
  });

  it("reads as core with no notices when nothing is selected", () => {
    const selection = resolveSkillPackSelection({ catalog, projectDefaultPackIds: undefined });
    expect(skillPacksRowValue({ catalog, selection })).toBe("core");
    const rows = buildSkillPacksSheetRows({ catalog, selection, providerWarning: null });
    expect(rows.packs[0]?.selected).toBe(false);
    expect(rows.notices).toEqual([]);
  });
});
