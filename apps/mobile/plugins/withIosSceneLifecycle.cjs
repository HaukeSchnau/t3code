const fs = require("node:fs");
const path = require("node:path");

const {
  createRunOncePlugin,
  withAppDelegate,
  withInfoPlist,
  withXcodeProject,
} = require("expo/config-plugins");

const SCENE_DELEGATE_FILE = "SceneDelegate.swift";
const SCENE_DELEGATE_SOURCE = `import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window

    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }

    appDelegate.reactNativeFactory?.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: appDelegate.launchOptions
    )
  }
}
`;

function withIosSceneLifecycle(config) {
  config = withInfoPlist(config, (nextConfig) => {
    nextConfig.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };

    return nextConfig;
  });

  config = withAppDelegate(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "swift") {
      throw new Error("withIosSceneLifecycle requires a Swift AppDelegate.");
    }

    nextConfig.modResults.contents = patchAppDelegate(nextConfig.modResults.contents);
    return nextConfig;
  });

  config = withXcodeProject(config, (nextConfig) => {
    const projectRoot = nextConfig.modRequest.platformProjectRoot;
    const projectName = nextConfig.modRequest.projectName;
    const appGroupKey = findAppGroupKey(nextConfig.modResults, projectName);

    if (appGroupKey == null) {
      throw new Error(`Could not find the ${projectName} Xcode group for ${SCENE_DELEGATE_FILE}.`);
    }

    const appSourceDir = path.join(projectRoot, projectName);
    fs.mkdirSync(appSourceDir, { recursive: true });
    fs.writeFileSync(path.join(appSourceDir, SCENE_DELEGATE_FILE), SCENE_DELEGATE_SOURCE);

    const sceneDelegateProjectPath = path.join(projectName, SCENE_DELEGATE_FILE);

    if (!xcodeProjectContainsFile(nextConfig.modResults, sceneDelegateProjectPath)) {
      const targetKey = nextConfig.modResults.findTargetKey(projectName);
      const target = targetKey ?? nextConfig.modResults.getFirstTarget().uuid;

      nextConfig.modResults.addSourceFile(
        sceneDelegateProjectPath,
        {
          target,
        },
        appGroupKey,
      );
    }

    return nextConfig;
  });

  return config;
}

function patchAppDelegate(contents) {
  let nextContents = contents;

  if (!nextContents.includes("var launchOptions: [UIApplication.LaunchOptionsKey: Any]?")) {
    const patchedContents = nextContents.replace(
      "class AppDelegate: ExpoAppDelegate {\n  var window: UIWindow?\n",
      "class AppDelegate: ExpoAppDelegate {\n  var launchOptions: [UIApplication.LaunchOptionsKey: Any]?\n",
    );

    if (patchedContents === nextContents) {
      throw new Error("Could not replace AppDelegate window storage with launch option storage.");
    }

    nextContents = patchedContents;
  }

  if (!nextContents.includes("self.launchOptions = launchOptions")) {
    nextContents = nextContents.replace(
      /(\n\s*\) -> Bool \{\n)/,
      "$1    self.launchOptions = launchOptions\n\n",
    );

    if (!nextContents.includes("self.launchOptions = launchOptions")) {
      throw new Error("Could not store launch options in AppDelegate.");
    }
  }

  const appDelegateStartBlock = `
#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

`;

  if (nextContents.includes(appDelegateStartBlock)) {
    return nextContents.replace(appDelegateStartBlock, "");
  }

  if (nextContents.includes("factory.startReactNative(")) {
    throw new Error(
      "Could not find AppDelegate React Native startup block to move into SceneDelegate.",
    );
  }

  return nextContents;
}

function findAppGroupKey(project, projectName) {
  return (
    project.findPBXGroupKey({ path: projectName }) ??
    project.findPBXGroupKey({ name: projectName }) ??
    null
  );
}

function xcodeProjectContainsFile(project, filePath) {
  const fileReferences = project.pbxFileReferenceSection();

  return Object.values(fileReferences).some((entry) => {
    return typeof entry !== "string" && entry?.path === filePath;
  });
}

module.exports = createRunOncePlugin(withIosSceneLifecycle, "with-ios-scene-lifecycle", "1.0.0");
