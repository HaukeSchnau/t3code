import { it } from "@effect/vitest";
import {
  type ManagedPolicySummary,
  ProviderDriverKind,
  ProviderInstanceId,
  type TextGeneratorConfig,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import * as TextGenerators from "./TextGenerators.ts";

const ID = ProviderInstanceId.make("router");

const layer = (generator: Partial<TextGeneratorConfig>, policy?: ManagedPolicySummary) =>
  Layer.effect(TextGenerators.TextGenerators, TextGenerators.make).pipe(
    Layer.provideMerge(
      ServerSettings.layerTest(
        {
          textGenerators: {
            [ID]: { kind: "openaiCompatible", baseUrl: "https://api.test/v1", ...generator },
          },
        },
        policy,
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
  );

const request = {
  operation: "generateThreadTitle",
  cwd: "/unused",
  prompt: "Name this thread.",
  outputSchema: Schema.Struct({ title: Schema.String }),
  modelSelection: { instanceId: ID, model: "some/model" },
} as const;

const chatMessages = { messages: [{ role: "user", content: "Name this thread." }] };

it.effect.each([
  {
    name: "Chat Completions",
    config: { kind: "openaiCompatible" },
    path: "/v1/chat/completions",
    auth: ["authorization", "Bearer secret"],
    body: chatMessages,
    reply: { choices: [{ finish_reason: "stop", message: { content: '{"title":"Fix login"}' } }] },
  },
  {
    name: "Responses API",
    config: { kind: "openaiCompatible", responsesApi: true },
    path: "/v1/responses",
    auth: ["authorization", "Bearer secret"],
    body: {
      input: "Name this thread.",
      store: false,
      reasoning: { effort: "low" },
      text: {
        format: {
          type: "json_schema",
          name: "output",
          strict: true,
          schema: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
    },
    reply: {
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", content: [{ type: "output_text", text: '{"title":"Fix login"}' }] },
      ],
    },
  },
  {
    name: "Anthropic",
    config: { kind: "anthropic" },
    path: "/v1/messages",
    auth: ["x-api-key", "secret"],
    body: chatMessages,
    reply: { stop_reason: "end_turn", content: [{ type: "text", text: '{"title":"Fix login"}' }] },
  },
] as const)("$name generates structured text with its API's request shape", (api) =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      expect(new URL(String(url)).pathname).toBe(api.path);
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get(api.auth[0])).toBe(api.auth[1]);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("some/model");
      expect(body).toMatchObject(api.body);
      expect(body.service_tier).toBeUndefined();
      return Response.json(api.reply);
    });
    const generators = yield* TextGenerators.TextGenerators.pipe(
      Effect.provide(layer({ ...api.config, apiKey: "secret" })),
    );
    const run = yield* generators.runner(ID);
    expect(run).toBeDefined();
    const result = yield* run!(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, upstream),
    );
    expect(result).toEqual({ title: "Fix login" });
    expect(yield* generators.runner(ProviderInstanceId.make("codex"))).toBeUndefined();

    upstream.mockResolvedValueOnce(
      Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 }),
    );
    const failure = yield* Effect.flip(
      run!(request).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
    );
    expect(failure.detail).toMatch(/rejected the API key: Incorrect API key provided$/);
  }),
);

it.effect("a Responses API generator sends the selection's reasoning effort and fast mode", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.reasoning).toEqual({ effort: "high" });
      expect(body.service_tier).toBe("priority");
      return Response.json({
        output: [{ type: "message", content: [{ type: "output_text", text: '{"title":"x"}' }] }],
      });
    });
    const generators = yield* TextGenerators.TextGenerators.pipe(
      Effect.provide(layer({ responsesApi: true })),
    );
    const run = yield* generators.runner(ID);
    yield* run!({
      ...request,
      modelSelection: {
        ...request.modelSelection,
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      },
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(upstream).toHaveBeenCalledOnce();
  }),
);

it.effect("a turned-off text generator fails instead of calling its API", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>();
    const generators = yield* TextGenerators.TextGenerators.pipe(
      Effect.provide(layer({ enabled: false, label: "OpenRouter" })),
    );
    const run = yield* generators.runner(ID);
    const failure = yield* Effect.flip(
      run!(request).pipe(Effect.provideService(FetchHttpClient.Fetch, upstream)),
    );
    expect(failure.detail).toBe("OpenRouter is off. Turn it on in Settings → Providers.");
    expect(upstream).not.toHaveBeenCalled();
  }),
);

it.effect("lists models once per config, following Anthropic pagination, until refreshed", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async (url) => {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/v1/models");
      return parsed.searchParams.get("after_id") === "claude-b"
        ? Response.json({ data: [{ id: "claude-a" }], has_more: false })
        : Response.json({
            data: [{ id: "claude-b", display_name: "Claude B" }],
            has_more: true,
            last_id: "claude-b",
          });
    });
    const program = Effect.gen(function* () {
      const generators = yield* TextGenerators.TextGenerators;
      const settings = yield* ServerSettings.ServerSettingsService;
      const list = (refresh?: boolean) =>
        generators
          .listModels({ id: ID, ...(refresh ? { refresh } : {}) })
          .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));

      expect((yield* list()).models).toEqual([
        { id: "claude-a", name: "claude-a" },
        { id: "claude-b", name: "Claude B" },
      ]);
      yield* list();
      expect(upstream).toHaveBeenCalledTimes(2);

      yield* list(true);
      expect(upstream).toHaveBeenCalledTimes(4);

      yield* settings.updateSettings({
        textGenerators: {
          [ID]: {
            kind: "anthropic",
            baseUrl: "https://api.test/v1",
            apiKey: "rotated",
            enabled: true,
          },
        },
      });
      yield* list();
      expect(upstream).toHaveBeenCalledTimes(6);
    });
    yield* program.pipe(Effect.provide(layer({ kind: "anthropic", apiKey: "secret" })));
  }),
);

it.effect("checks unsaved settings, keeping the saved key behind a redaction marker", () =>
  Effect.gen(function* () {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return String(url).endsWith("/chat/completions")
        ? Response.json({
            model: JSON.parse(String(init?.body)).model,
            choices: [{ finish_reason: "stop", message: { content: "OK" } }],
          })
        : Response.json({ data: [{ id: "model-a" }] });
    });
    const generators = yield* TextGenerators.TextGenerators.pipe(
      Effect.provide(layer({ apiKey: "saved-key" })),
    );
    const list = (id: string, config: Partial<TextGeneratorConfig>) =>
      generators
        .listModels({
          id: ProviderInstanceId.make(id),
          config: {
            kind: "openaiCompatible",
            baseUrl: "https://new.test/v1",
            apiKey: "",
            enabled: true,
            ...config,
          },
        })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));

    expect((yield* list("draft", { apiKey: "typed-key" })).models).toEqual([
      { id: "model-a", name: "model-a" },
    ]);
    yield* list(ID, { apiKey: SECRET_REDACTED });
    expect(seen).toEqual([
      { url: "https://new.test/v1/models", auth: "Bearer typed-key" },
      { url: "https://new.test/v1/models", auth: "Bearer saved-key" },
    ]);

    // Listing alone proves nothing about the key on some APIs; a test asks the model itself.
    const tested = yield* generators
      .listModels({ id: ID, test: true, model: "chosen/model" })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));
    expect(tested.testedModel).toBe("chosen/model");
    expect(seen.at(-1)).toEqual({
      url: "https://api.test/v1/chat/completions",
      auth: "Bearer saved-key",
    });

    // An allow-list names agent drivers only, so no unsaved config may reach an API either.
    const managed = yield* TextGenerators.TextGenerators.pipe(
      Effect.provide(
        layer(
          { apiKey: "saved-key" },
          {
            organization: "Example Corp",
            lockedSettings: [],
            limits: {
              providers: {
                allowedDrivers: [ProviderDriverKind.make("codex")],
                lockedInstanceFields: {},
              },
            },
          },
        ),
      ),
    );
    const requestsBefore = seen.length;
    const refused = yield* managed
      .listModels({
        id: ProviderInstanceId.make("draft"),
        config: {
          kind: "openaiCompatible",
          baseUrl: "https://new.test/v1",
          apiKey: "k",
          enabled: true,
        },
        test: true,
      })
      .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream), Effect.flip);
    expect(refused.detail).toContain("policy");
    expect(seen).toHaveLength(requestsBefore);
  }),
);
