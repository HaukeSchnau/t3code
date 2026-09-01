# Codex default model

T3 Code uses GPT-5.6 Sol with high reasoning as the default for the built-in Codex provider.

The live Codex model catalog can advertise another reasoning default, so the provider snapshot marks
high as Sol's default whenever the catalog supports it. Migration 61 also moves persisted built-in
Codex project defaults from GPT-5.4 to GPT-5.6 Sol at high reasoning. It preserves unrelated model
options and leaves current threads, custom provider instances, and explicit choices for other models
unchanged.

Keep this fork patch while existing project defaults need automatic upgrades or upstream does not
support a configurable global Codex default with reasoning effort. Remove it when upstream provides
that setting and migration path.
