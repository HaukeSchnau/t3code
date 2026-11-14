# Responses API text generator

## Requirement

Voice cleanup and other text generation can run on a ChatGPT subscription through a pool that
serves it over OpenAI's Responses API (CLIProxyAPI). It has to be fast: on `gpt-6-luna` with
reasoning effort `low` and priority processing (fast mode), a 95-word cleanup took 2.1 to 2.8 s
over two runs of six calls to a dev server's `/api/voice/post-process`, against 3.7 s through `claude -p` and 3.4 s on
the endpoint's defaults.

## Why upstream does not meet it

Upstream's text generators speak Chat Completions or Anthropic Messages. They send only the model
and the prompt, so a model's reasoning effort and service tier stay at the endpoint's defaults, and
nothing enforces the reply's JSON shape. Their models reach the picker without option descriptors.

## Design

- `TextGeneratorConfig.responsesApi` marks an `openaiCompatible` generator that uses the Responses
  API. It is a field rather than a new kind: clients built before it ignore an unknown field, but
  fail to decode all server settings on an unknown kind.
- `textGeneratorDriver` in `apps/server/src/textGeneration/textGeneratorDrivers.ts` picks the
  Responses driver for it. That driver posts to `/responses` with `store: false`, the operation's
  output schema as a strict `json_schema` format, the selection's `reasoningEffort` (default `low`,
  as for other text generation) and, for `fastMode`, `service_tier: "priority"`. The other drivers
  are unchanged.
- `apps/web/src/textGenerators.ts` gives such a generator's models reasoning and fast mode
  descriptors, so the existing traits pickers next to text generation model pickers set them.
- The generator dialog shows a **Responses API** switch for every OpenAI-compatible generator, new
  or saved.

## Removal

Remove this when upstream text generators speak the Responses API and pass reasoning effort and
service tier from the model selection.

## Verification

`TextGenerators.test.ts`: the "Responses API" row of "generates structured text with its API's
request shape", and "a Responses API generator sends the selection's reasoning effort and fast mode".
