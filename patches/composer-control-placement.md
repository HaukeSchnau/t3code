# Composer control placement

Restore upstream's single shared set of composer controls after the September 3
merge (`d34cb984`) retained the old footer alongside the new resting strip.
Model, reasoning effort, and access controls must render in the footer when
expanded and in the context strip when resting or collapsed, never in both.

`apps/web/src/components/chat/ChatComposer.tsx` uses `composerControls` in both
locations with mutually exclusive conditions. The footer also retains upstream's
measurement ref and control attributes. This covers web and the desktop wrapper;
the native mobile composer uses a separate implementation.

This is an upstream restoration, with no additional fork behavior to preserve.
Keep upstream's conditional placement during future syncs and retire this note
when the surrounding composer implementation is fully reconciled.
