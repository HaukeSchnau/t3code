const path = require("node:path");

// The Apple Watch app. It reaches T3 Code servers through the iPhone app; see
// patches/apple-watch.md and modules/t3-agent-notifications/ios/WatchBridge.swift.
/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: "watch",
  name: "T3CodeWatch",
  displayName: "T3 Code",
  bundleIdentifier: ".watchkitapp",
  deploymentTarget: "11.0",
  // The app config's icon is relative to apps/mobile; apple-targets resolves from this folder.
  ...(config.icon ? { icon: path.join("..", "..", config.icon) } : {}),
  frameworks: ["SwiftUI", "WatchConnectivity", "UserNotifications", "WatchKit"],
});
