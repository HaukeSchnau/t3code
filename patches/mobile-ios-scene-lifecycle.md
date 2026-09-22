# Mobile iOS bundle identifiers

The fork accepts `T3CODE_IOS_BUNDLE_IDENTIFIER_BASE` during Expo prebuild so local
Apple teams can provision their own identifiers. For example,
`T3CODE_IOS_BUNDLE_IDENTIFIER_BASE=dev.schnau.t3code` produces
`dev.schnau.t3code` for production, `dev.schnau.t3code.dev` for development, and
matching widget and app group identifiers.

Upstream now moves React Native startup into the UIKit scene lifecycle and preserves
launch options. The fork uses that implementation and its prebuild tests; the separate
SceneDelegate generator is no longer needed. Regenerate disposable native projects
with `expo prebuild --clean` when switching from the old generator.

Remove the bundle identifier override when upstream exposes an equivalent setting.
