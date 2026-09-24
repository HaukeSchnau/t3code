# Mobile iOS bundle identifiers

Expo prebuild derives the iOS bundle identifiers from `T3CODE_IOS_BUNDLE_IDENTIFIER_BASE`, so the
fork's Apple team can provision its own identifiers. The base defaults to `dev.schnau.t3code`, which
produces `dev.schnau.t3code` for production, `dev.schnau.t3code.dev` for development and
`dev.schnau.t3code.preview` for preview. Widget, share-extension and App Group identifiers follow
the same base.

Signing uses `T3CODE_IOS_TEAM_ID`, which defaults to the fork's team `2243J9RD68`. Personal-team
builds keep upstream's `T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID` override.

Remove this patch when upstream exposes an equivalent bundle identifier and team setting.
