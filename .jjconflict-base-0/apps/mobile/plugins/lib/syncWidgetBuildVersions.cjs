"use strict";

// Keep a generated widget extension's version aligned with its containing app.
// expo-widgets otherwise leaves MARKETING_VERSION at 1.0, and Xcode replaces
// the literal Info.plist value with that build setting during packaging.

function stripComments(section) {
  return Object.fromEntries(
    Object.entries(section ?? {}).filter(([key]) => !key.endsWith("_comment")),
  );
}

function findTargetByName(section, name) {
  return Object.values(stripComments(section)).find((target) => target?.name === name) ?? null;
}

/**
 * @param {import('xcode').XcodeProject} project
 * @param {{ targetName: string, marketingVersion: string, buildNumber: string }} options
 */
function syncWidgetBuildVersions(project, options) {
  const objects = project.hash.project.objects;
  const target = findTargetByName(objects.PBXNativeTarget, options.targetName);
  if (!target) {
    throw new Error(`Widget target "${options.targetName}" not found.`);
  }

  const configurationList = stripComments(objects.XCConfigurationList)[
    target.buildConfigurationList
  ];
  if (!configurationList) {
    throw new Error(`Build configurations for "${options.targetName}" not found.`);
  }

  const buildConfigurations = stripComments(objects.XCBuildConfiguration);
  for (const reference of configurationList.buildConfigurations ?? []) {
    const buildConfiguration = buildConfigurations[reference.value];
    if (!buildConfiguration?.buildSettings) continue;
    buildConfiguration.buildSettings.MARKETING_VERSION = options.marketingVersion;
    buildConfiguration.buildSettings.CURRENT_PROJECT_VERSION = options.buildNumber;
  }
}

module.exports = { syncWidgetBuildVersions };
