# Mobile native content surfaces

## Fork requirement

Composer token chips on iOS must stay atomic editable tokens. UIKit draws them with
`NSTextAttachment`, so iOS 17 and later treat them as images, opening a preview on tap and
offering Save to Camera Roll in the menu. Upstream leaves those actions on.

## Implementation

`apps/mobile/modules/t3-composer-editor/ios/T3ComposerEditorView.swift` implements the iOS 17
`UITextViewDelegate` methods `textView(_:primaryActionFor:defaultAction:)` and
`textView(_:menuConfigurationFor:defaultMenu:)`. Both return `nil` for a `ComposerTextAttachment`
and keep the default for every other text item.

The other native surfaces are upstream's: Markdown text, review diff, terminal and the rest of the
composer. The inline-code link change in the Markdown module belongs to
[inline-code links](inline-code-links.md).

## Removal

Drop this patch when upstream suppresses image actions on composer chips.

## Verification

On an iPhone with iOS 17 or later, tap and long-press a chip in the composer. Neither shows an
image preview or Save to Camera Roll.
