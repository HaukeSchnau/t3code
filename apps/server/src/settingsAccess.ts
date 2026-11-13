import {
  type ProviderInstanceMutation,
  ServerSettings,
  type ServerSettingsApplyInput,
  type ServerSettingsError,
  ServerSettingsPatch,
  type ServerSettingsSnapshot,
  type ServerSettingsUpdateResult,
  type StoredSettingsChange,
  type StoredSettingsDocument,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";

import { remoteSshDeviceHosts } from "./device/localSshDeviceHost.ts";
import {
  ATOMIC_SETTINGS_KEYS,
  redactServerSettingsForClient,
  ServerSettingsService,
  type SettingsSecretWrite,
  type SettingsUpdatePlan,
  type SettingsUpdateReport,
  StoredServerSettings,
  stripDefaultServerSettings,
} from "./serverSettings.ts";

export class SettingsDocumentError extends Schema.TaggedError<SettingsDocumentError>()(
  "SettingsDocumentError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

// `t3 settings` shows secret references as they are, so a document built from it can send them back.
const settingsClient = { secretReferences: true } as const;

// Every save derives these from another key, so a document never holds them.
const DERIVED_KEYS: ReadonlySet<string> = new Set([
  "compactIdleThreads",
  "projectAgentBrowserAccessOverrides",
  "projectAutoPullOverrides",
  "projectScriptOverrides",
  "automaticGitFetchInterval",
  "providerHealthRefreshInterval",
  "backgroundActivityProfile",
]);
const DOCUMENT_KEYS: ReadonlyArray<string> = Object.keys(ServerSettings.fields).filter(
  (key) => Object.hasOwn(ServerSettingsPatch.fields, key) && !DERIVED_KEYS.has(key),
);
// A patch sets or removes (null) one entry of these at a time.
const ENTRY_PATCH_KEYS: ReadonlySet<string> = new Set([
  "projectSettingsOverrides",
  "usageLimitSources",
  "textGenerators",
  "secretProviders",
  "usagePriceOverrides",
  "usageModelAliases",
  "sourceControlHosts",
]);
// Changes compare the entries of these maps whole.
const ENTRY_KEYS: ReadonlySet<string> = new Set([
  ...ENTRY_PATCH_KEYS,
  "providerInstances",
  "providerModelPreferences",
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAtomicPath = (path: ReadonlyArray<string>) =>
  (path.length === 1 && ATOMIC_SETTINGS_KEYS.has(path[0]!)) ||
  (path.length === 2 && ENTRY_KEYS.has(path[0]!));

const pickDocumentKeys = (settings: unknown): Record<string, unknown> =>
  isPlainRecord(settings)
    ? Object.fromEntries(
        DOCUMENT_KEYS.flatMap((key) => (key in settings ? [[key, settings[key]]] : [])),
      )
    : {};

const encodeDocument = Schema.encodeUnknownEffect(ServerSettings);

/** The stored settings as a document: what differs from `defaults`, secrets redacted. */
const settingsDocument = (settings: ServerSettings, defaults: ServerSettings) =>
  encodeDocument(
    pickDocumentKeys(
      stripDefaultServerSettings(redactServerSettingsForClient(settings, settingsClient), defaults),
    ),
  ).pipe(
    Effect.map((document) => document as StoredSettingsDocument),
    Effect.orDie,
  );

/** The paths whose values differ, in key order; arrays, atomic settings and map entries compare whole. */
function documentChanges(
  before: unknown,
  after: unknown,
  path: ReadonlyArray<string> = [],
): ReadonlyArray<StoredSettingsChange> {
  const recurse =
    !isAtomicPath(path) &&
    (isPlainRecord(before) || before === undefined) &&
    (isPlainRecord(after) || after === undefined) &&
    (before !== undefined || after !== undefined);
  if (recurse) {
    const from = isPlainRecord(before) ? before : {};
    const to = isPlainRecord(after) ? after : {};
    return [...new Set([...Object.keys(from), ...Object.keys(to)])]
      .toSorted()
      .flatMap((key) => documentChanges(from[key], to[key], [...path, key]));
  }
  if (Equal.equals(before, after)) return [];
  return [
    {
      path,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    },
  ];
}

function setDocumentPath(
  document: Record<string, unknown>,
  [key, ...rest]: ReadonlyArray<string>,
  value: unknown,
): Record<string, unknown> {
  const next = { ...document };
  const existing = next[key!];
  const child =
    rest.length === 0
      ? value
      : setDocumentPath(isPlainRecord(existing) ? existing : {}, rest, value);
  if (
    child === undefined ||
    (isPlainRecord(child) && rest.length > 0 && Object.keys(child).length === 0)
  ) {
    delete next[key!];
  } else {
    next[key!] = child;
  }
  return next;
}

/** `current` with only the paths where `desired` differs from `base` changed. */
const rebaseDocument = (
  current: StoredSettingsDocument,
  base: StoredSettingsDocument,
  desired: StoredSettingsDocument,
) =>
  documentChanges(base, desired).reduce(
    (document, change) => setDocumentPath(document, change.path, change.after),
    current as Record<string, unknown>,
  );

const decodePatch = Schema.decodeUnknownEffect(Schema.toType(ServerSettingsPatch));

/** The patch that takes the document keys of `current` to those of `target`. */
const patchToward = (current: ServerSettings, target: ServerSettings) => {
  const patch: Record<string, unknown> = {};
  for (const key of DOCUMENT_KEYS) {
    const from = (current as Record<string, unknown>)[key];
    const to = (target as Record<string, unknown>)[key];
    if (Equal.equals(from, to)) continue;
    if (!ENTRY_PATCH_KEYS.has(key)) {
      patch[key] = to;
      continue;
    }
    const fromEntries = isPlainRecord(from) ? from : {};
    const toEntries = isPlainRecord(to) ? to : {};
    patch[key] = Object.fromEntries(
      [...new Set([...Object.keys(fromEntries), ...Object.keys(toEntries)])].flatMap((id) =>
        Equal.equals(fromEntries[id], toEntries[id]) ? [] : [[id, toEntries[id] ?? null]],
      ),
    );
  }
  return decodePatch(patch).pipe(
    Effect.mapError(
      (cause) =>
        new SettingsDocumentError({
          detail: `A settings patch cannot express this change.\n${cause.message}`,
        }),
    ),
  );
};

export function settingsErrorMessage(error: ServerSettingsError): string {
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause === undefined || cause.length === 0 ? error.message : `${error.message}\n${cause}`;
}

const secretLocation = (write: SettingsSecretWrite) =>
  write.providerInstanceId !== undefined && write.environmentVariable !== undefined
    ? `providerInstances.${write.providerInstanceId}.environment.${write.environmentVariable}`
    : write.secretName;

const updateResult = Effect.fn("settingsAccess.updateResult")(function* (
  report: SettingsUpdateReport,
) {
  const before = yield* settingsDocument(report.before, report.defaults);
  const after = yield* settingsDocument(report.after, report.defaults);
  return {
    changes: documentChanges(before, after),
    secrets: report.secrets
      .map((write) => ({ secret: secretLocation(write), change: write.change }))
      .toSorted((left, right) => left.secret.localeCompare(right.secret)),
    written: report.written,
  } satisfies ServerSettingsUpdateResult;
});

export const readSettingsSnapshot = Effect.fn("settingsAccess.snapshot")(function* () {
  const { stored, defaults, effective } = yield* (yield* StoredServerSettings).read;
  return {
    settings: redactServerSettingsForClient(effective, settingsClient),
    stored: yield* settingsDocument(stored, defaults),
  } satisfies ServerSettingsSnapshot;
});

const settingsUpdatePlan = Effect.fn("settingsAccess.plan")(function* (input: {
  readonly patch: ServerSettingsPatch;
  readonly providerInstanceMutation?: ProviderInstanceMutation | undefined;
}) {
  const deviceHosts = input.patch.deviceHosts
    ? yield* remoteSshDeviceHosts(input.patch.deviceHosts)
    : undefined;
  return {
    patch: { ...input.patch, ...(deviceHosts ? { deviceHosts } : {}) },
    ...(input.providerInstanceMutation === undefined
      ? {}
      : { providerInstanceMutation: input.providerInstanceMutation }),
  } satisfies SettingsUpdatePlan;
});

/** The server.updateSettings RPC, which the settings UI calls. */
export const updateSettingsForClient = Effect.fn("settingsAccess.update")(function* (input: {
  readonly patch: ServerSettingsPatch;
  readonly providerInstanceMutation?: ProviderInstanceMutation | undefined;
}) {
  const service = yield* ServerSettingsService;
  const { patch, providerInstanceMutation } = yield* settingsUpdatePlan(input);
  return yield* providerInstanceMutation === undefined
    ? service.updateSettings(patch)
    : service.updateProviderInstance(providerInstanceMutation, patch);
});

export const patchStoredSettings = Effect.fn("settingsAccess.patch")(function* (
  patch: ServerSettingsPatch,
) {
  const plan = yield* settingsUpdatePlan({ patch });
  const report = yield* (yield* StoredServerSettings).update({ plan: () => Effect.succeed(plan) });
  return yield* updateResult(report);
});

export const applyStoredSettings = Effect.fn("settingsAccess.apply")(function* (
  input: ServerSettingsApplyInput,
) {
  const stored = yield* StoredServerSettings;
  const decodeDocument = (label: string, document: StoredSettingsDocument) => {
    const unknown = Object.keys(document).filter((key) => !DOCUMENT_KEYS.includes(key));
    return unknown.length > 0
      ? Effect.fail(
          new SettingsDocumentError({
            detail: `${label} holds keys a settings document cannot set: ${unknown.join(", ")}. \`t3 settings get --sparse\` prints the document form.`,
          }),
        )
      : stored.decodeDocument(document).pipe(
          Effect.mapError(
            (error) =>
              new SettingsDocumentError({
                detail: `${label} is not a valid settings document.\n${settingsErrorMessage(error)}`,
              }),
          ),
        );
  };
  yield* decodeDocument("The desired document", input.desired);
  if (input.base !== undefined) yield* decodeDocument("The base document", input.base);

  let expected: { readonly target: ServerSettings; readonly defaults: ServerSettings } | undefined;
  const documentValues = (settings: ServerSettings, defaults: ServerSettings) =>
    pickDocumentKeys(stripDefaultServerSettings(settings, defaults));
  const report = yield* stored.update<SettingsDocumentError>({
    dryRun: input.dryRun,
    plan: Effect.fn("settingsAccess.applyPlan")(function* (
      current: ServerSettings,
      defaults: ServerSettings,
    ) {
      const document =
        input.base === undefined
          ? input.desired
          : rebaseDocument(yield* settingsDocument(current, defaults), input.base, input.desired);
      const target = yield* decodeDocument("The resulting document", document);
      expected = { target, defaults };
      return { patch: yield* patchToward(current, target) };
    }),
    // A patch merges some values; refuse rather than store something other than the document.
    check: (next) => {
      if (expected === undefined) return Effect.void;
      const want = documentValues(expected.target, expected.defaults);
      const got = documentValues(next, expected.defaults);
      const missed = DOCUMENT_KEYS.filter((key) => !Equal.equals(want[key], got[key]));
      return missed.length === 0
        ? Effect.void
        : Effect.fail(
            new SettingsDocumentError({
              detail: `A settings patch cannot reach the document for: ${missed.join(", ")}. Nothing was changed.`,
            }),
          );
    },
  });
  return yield* updateResult(report);
});
