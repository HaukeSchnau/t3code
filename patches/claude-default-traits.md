# Claude default traits

The built-in Claude provider defaults selectable context windows to 200k. The 1M option remains
available for models that support it. Fable models also default to medium reasoning effort, while
their other effort levels remain selectable.

These defaults apply when a project or thread has no explicit stored choice. Existing selections
continue to win.

Keep this fork patch while upstream defaults Claude models to 1M and Fable to high effort. Remove it
if upstream adopts these defaults or adds equivalent provider-level settings.
