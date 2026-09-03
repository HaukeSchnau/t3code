import * as NodeModule from "node:module";
import { describe, expect, it } from "vitest";

const require = NodeModule.createRequire(import.meta.url);
const { syncWidgetBuildVersions } = require("./syncWidgetBuildVersions.cjs") as {
  syncWidgetBuildVersions: (
    project: unknown,
    options: { targetName: string; marketingVersion: string; buildNumber: string },
  ) => void;
};

function makeProject() {
  return {
    hash: {
      project: {
        objects: {
          PBXNativeTarget: {
            TARGET: { name: "ExpoWidgetsTarget", buildConfigurationList: "CONFIGURATIONS" },
            TARGET_comment: "ExpoWidgetsTarget",
          },
          XCConfigurationList: {
            CONFIGURATIONS: {
              buildConfigurations: [{ value: "DEBUG" }, { value: "RELEASE" }],
            },
          },
          XCBuildConfiguration: {
            DEBUG: { buildSettings: { CURRENT_PROJECT_VERSION: "1", MARKETING_VERSION: "1.0" } },
            RELEASE: {
              buildSettings: { CURRENT_PROJECT_VERSION: "1", MARKETING_VERSION: "1.0" },
            },
          },
        },
      },
    },
  };
}

describe("syncWidgetBuildVersions", () => {
  it("aligns every widget build configuration with the containing app", () => {
    const project = makeProject();

    syncWidgetBuildVersions(project, {
      targetName: "ExpoWidgetsTarget",
      marketingVersion: "1.0.2",
      buildNumber: "42",
    });

    expect(project.hash.project.objects.XCBuildConfiguration).toMatchObject({
      DEBUG: { buildSettings: { CURRENT_PROJECT_VERSION: "42", MARKETING_VERSION: "1.0.2" } },
      RELEASE: { buildSettings: { CURRENT_PROJECT_VERSION: "42", MARKETING_VERSION: "1.0.2" } },
    });
  });

  it("fails when expo-widgets did not generate its target", () => {
    expect(() =>
      syncWidgetBuildVersions(makeProject(), {
        targetName: "MissingWidgetTarget",
        marketingVersion: "1.0.2",
        buildNumber: "42",
      }),
    ).toThrow('Widget target "MissingWidgetTarget" not found.');
  });
});
