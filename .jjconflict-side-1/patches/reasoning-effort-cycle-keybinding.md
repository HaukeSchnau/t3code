# Reasoning effort cycle keybinding

T3 Code adds a configurable `reasoningEffort.cycle` command with the default shortcut
`mod+shift+.`. It advances the active composer's reasoning effort through the ordered values
advertised by the selected model and wraps after the final value.

The command is inactive while a terminal owns keyboard focus. Models without a selectable
reasoning-effort descriptor ignore the command. Cycling persists the selection through the same
composer draft and sticky-option path used by the traits picker, so subsequent threads inherit the
user's latest choice.

This is a fork-specific productivity feature. When syncing upstream, remove this patch only if
upstream provides an equivalent configurable command that uses model-advertised option values.
