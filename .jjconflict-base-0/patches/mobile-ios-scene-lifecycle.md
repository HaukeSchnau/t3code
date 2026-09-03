# Mobile iOS Scene Lifecycle

## Why this patch exists

iOS 27 beta terminates apps that still create their main `UIWindow` from `AppDelegate`
without adopting UIKit scenes. The generated Expo/React Native iOS project used that
older startup path, which made both the release app and Expo Dev Client crash at
launch with `___UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption_block_invoke`.

## Patch

`apps/mobile/plugins/withIosSceneLifecycle.cjs` makes the generated iOS project adopt
the scene lifecycle during `expo prebuild`:

- adds `UIApplicationSceneManifest` to `Info.plist`
- writes `SceneDelegate.swift`
- stores launch options on `AppDelegate`
- moves React Native startup into `SceneDelegate.scene(_:willConnectTo:options:)`
- registers `SceneDelegate.swift` with the app Xcode target

This keeps `apps/mobile/ios` disposable: deleting and regenerating the native project
must preserve the crash fix.

For local Apple teams that cannot provision the default `com.t3tools.t3code`
identifiers, set `T3CODE_IOS_BUNDLE_IDENTIFIER_BASE` before prebuild. For example,
`T3CODE_IOS_BUNDLE_IDENTIFIER_BASE=dev.schnau.t3code` produces
`dev.schnau.t3code` for production, `dev.schnau.t3code.dev` for development, and
matching widget and app group identifiers.

## Verification

Regenerate and build at least one iOS variant:

```sh
APP_VARIANT=production EXPO_NO_GIT_STATUS=1 pnpm --dir apps/mobile exec expo prebuild --clean --platform ios
APP_VARIANT=production xcodebuild -workspace apps/mobile/ios/T3Code.xcworkspace -scheme T3Code -configuration Release -destination 'generic/platform=iOS' -allowProvisioningUpdates DEVELOPMENT_TEAM=2243J9RD68 CODE_SIGN_STYLE=Automatic IPHONEOS_DEPLOYMENT_TARGET=18.0 build
```

Before considering the mobile patch complete, also run:

```sh
vp run lint:mobile
vp check
vp run typecheck
```
