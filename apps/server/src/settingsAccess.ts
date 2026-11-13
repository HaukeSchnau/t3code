import {
  isSecretReference,
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
  type SettingsUpdatePlan,
  type SettingsUpdateReport,
  StoredServerSettings,
  stripDefaultServerSettings,
} from "./serverSettings.ts";
import { mapSettingsSecrets, type SettingsSecret } from "./settingsSecrets.ts";

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
// A document that drops an entry of these maps drops it whole.
const ENTRY_KEYS: ReadonlySet<string> = new Set([
  ...ENTRY_PATCH_KEYS,
  "providerInstances",
  "providerModelPreferences",
]);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Variable names such as `constructor` must not read Object.prototype.
const own = (record: Record<string, unknown>, key: string) =>
  Object.hasOwn(record, key) ? record[key] : undefined;

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

// A provider's environment is a list, but its variables are compared and rebased by name.
const isKeyedArrayPath = (path: ReadonlyArray<string>) =>
  path.length === 3 && path[0] === "providerInstances" && path[2] === "environment";

const byName = (value: unknown): Record<string, unknown> | undefined =>
  Array.isArray(value)
    ? Object.fromEntries(
        value.map((entry) => [isPlainRecord(entry) ? String(entry.name) : "", entry]),
      )
    : undefined;

/**
 * The paths whose values differ, in key order, leaf by leaf so a rebase keeps edits beside them.
 * Arrays, atomic settings, secret references and environment variables compare whole, as does a
 * map entry one side lacks.
 */
function documentChanges(
  before: unknown,
  after: unknown,
  path: ReadonlyArray<string> = [],
): ReadonlyArray<StoredSettingsChange> {
  const keyed = isKeyedArrayPath(path);
  const from = keyed ? (byName(before) ?? before) : before;
  const to = keyed ? (byName(after) ?? after) : after;
  const whole =
    (path.length === 1 && ATOMIC_SETTINGS_KEYS.has(path[0]!)) ||
    (path.length === 2 && ENTRY_KEYS.has(path[0]!) && after === undefined) ||
    isKeyedArrayPath(path.slice(0, -1)) ||
    isSecretReference(before) ||
    isSecretReference(after);
  const recurse =
    !whole &&
    (isPlainRecord(from) || from === undefined) &&
    (isPlainRecord(to) || to === undefined) &&
    (from !== undefined || to !== undefined);
  if (recurse) {
    const fromRecord = isPlainRecord(from) ? from : {};
    const toRecord = isPlainRecord(to) ? to : {};
    return [...new Set([...Object.keys(fromRecord), ...Object.keys(toRecord)])]
      .toSorted()
      .flatMap((key) => documentChanges(own(fromRecord, key), own(toRecord, key), [...path, key]));
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

function setKeyedEntry(entries: ReadonlyArray<unknown>, name: string, value: unknown) {
  const index = entries.findIndex((entry) => isPlainRecord(entry) && entry.name === name);
  if (value === undefined) return entries.filter((_, at) => at !== index);
  return index === -1
    ? [...entries, value]
    : entries.map((entry, at) => (at === index ? value : entry));
}

function setDocumentPath(
  document: Record<string, unknown>,
  [key, ...rest]: ReadonlyArray<string>,
  value: unknown,
  prefix: ReadonlyArray<string> = [],
): Record<string, unknown> {
  const next = { ...document };
  const existing = next[key!];
  const here = [...prefix, key!];
  const child =
    rest.length === 0
      ? value
      : isKeyedArrayPath(here) && rest.length === 1
        ? setKeyedEntry(Array.isArray(existing) ? existing : [], rest[0]!, value)
        : setDocumentPath(isPlainRecord(existing) ? existing : {}, rest, value, here);
  if (child === undefined) delete next[key!];
  else next[key!] = child;
  return next;
}

const getDocumentPath = (document: unknown, path: ReadonlyArray<string>) =>
  path.reduce<unknown>(
    (value, key) => (isPlainRecord(value) ? own(value, key) : undefined),
    document,
  );

const isEmpty = (value: unknown) =>
  Array.isArray(value)
    ? value.length === 0
    : isPlainRecord(value) && Object.keys(value).length === 0;

/** Drops the containers a removal emptied, unless the desired document has them. */
function pruneEmptied(
  document: Record<string, unknown>,
  path: ReadonlyArray<string>,
  desired: StoredSettingsDocument,
) {
  let next = document;
  for (let depth = path.length - 1; depth > 0; depth--) {
    const parent = path.slice(0, depth);
    if (!isEmpty(getDocumentPath(next, parent)) || getDocumentPath(desired, parent) !== undefined) {
      break;
    }
    next = setDocumentPath(next, parent, undefined);
  }
  return next;
}

/**
 * `current` with only the paths where `desired` differs from `base` changed. A change inside a
 * map entry that `current` no longer has brings the whole desired entry back.
 */
const rebaseDocument = (
  current: StoredSettingsDocument,
  base: StoredSettingsDocument,
  desired: StoredSettingsDocument,
) =>
  documentChanges(base, desired).reduce(
    (document, change) => {
      const entry = change.path.slice(0, 2);
      if (
        change.path.length > 2 &&
        ENTRY_KEYS.has(change.path[0]!) &&
        getDocumentPath(document, entry) === undefined
      ) {
        return setDocumentPath(document, entry, getDocumentPath(desired, entry));
      }
      const next = setDocumentPath(document, change.path, change.after);
      return change.after === undefined ? pruneEmptied(next, change.path, desired) : next;
    },
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
    // Its patch merges each host's fields and has no way to remove a host.
    const unremovable =
      key === "sourceControlHosts"
        ? Object.keys(fromEntries).filter((id) => toEntries[id] === undefined)
        : [];
    if (unremovable.length > 0) {
      return Effect.fail(
        new SettingsDocumentError({
          detail: `A settings patch cannot remove sourceControlHosts entries: ${unremovable.join(", ")}. Nothing was changed. Keep them in the document, or clear them in the Settings page.`,
        }),
      );
    }
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

const secretLocation = (
  secret: Pick<SettingsSecret, "secretName" | "providerInstanceId" | "environmentVariable">,
) =>
  secret.providerInstanceId !== undefined && secret.environmentVariable !== undefined
    ? `providerInstances.${secret.providerInstanceId}.environment.${secret.environmentVariable}`
    : secret.secretName;

/** Sensitive secret slots by name that hold a value or a saved-secret marker. */
function secretSlots(settings: ServerSettings) {
  const held = new Map<string, string>();
  const marked = new Map<string, string>();
  mapSettingsSecrets(settings, (secret) => {
    if (secret.sensitive) {
      if (secret.redacted) marked.set(secret.secretName, secretLocation(secret));
      if (secret.redacted || secret.value.length > 0) {
        held.set(secret.secretName, secretLocation(secret));
      }
    }
    return secret;
  });
  return { held, marked };
}

const describeValue = (value: unknown) =>
  value === undefined ? "the default" : JSON.stringify(value);

function unreachableMessage(changes: ReadonlyArray<StoredSettingsChange>): string {
  return [
    "A settings patch cannot reach the document. Nothing was changed.",
    ...changes.map(
      (change) =>
        `  ${change.path.join(".")}: would store ${describeValue(change.before)}, the document says ${describeValue(change.after)}`,
    ),
  ].join("\n");
}

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
  const desired = yield* decodeDocument("The desired document", input.desired);
  const base =
    input.base === undefined ? undefined : yield* decodeDocument("The base document", input.base);
  // With --base, a secret the host holds that neither document holds was set in the UI. Only the
  // repository can remove its own secrets; the reconciler only ever captures a secret's marker.
  const repositorySecrets =
    base === undefined
      ? undefined
      : new Set([...secretSlots(base).held.keys(), ...secretSlots(desired).held.keys()]);
  const deviceHostContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof remoteSshDeviceHosts>>>();

  let expected:
    | {
        readonly current: ServerSettings;
        readonly target: ServerSettings;
        readonly defaults: ServerSettings;
      }
    | undefined;
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
      const decoded = yield* decodeDocument("The resulting document", document);
      const held = secretSlots(current).held;
      const keep = new Set(
        repositorySecrets === undefined
          ? []
          : [...held.keys()].filter((name) => !repositorySecrets.has(name)),
      );
      // As in the settings UI, an SSH device host that is this machine is left out.
      const target = {
        ...mapSettingsSecrets(decoded, (secret) =>
          keep.has(secret.secretName) ? { value: "", redacted: true } : secret,
        ),
        deviceHosts: yield* remoteSshDeviceHosts(decoded.deviceHosts).pipe(
          Effect.provide(deviceHostContext),
        ),
      };
      const unheld = [...secretSlots(target).marked]
        .filter(([name]) => !held.has(name))
        .map(([, location]) => location);
      if (unheld.length > 0) {
        return yield* new SettingsDocumentError({
          detail: `The document marks secrets as saved that this host does not hold: ${unheld.join(", ")}. Nothing was changed. Put their values in the document instead.`,
        });
      }
      expected = { current, target, defaults };
      return { patch: yield* patchToward(current, target) };
    }),
    check: Effect.fn("settingsAccess.applyCheck")(function* (next: ServerSettings) {
      if (expected === undefined) return;
      if (repositorySecrets !== undefined) {
        const kept = secretSlots(next).held;
        const dropped = [...secretSlots(expected.current).held]
          .filter(([name]) => !kept.has(name) && !repositorySecrets.has(name))
          .map(([, location]) => location);
        if (dropped.length > 0) {
          return yield* new SettingsDocumentError({
            detail: `This would remove secrets set outside the documents: ${dropped.join(", ")}. Nothing was changed. Capture them into the documents first, or remove them in the Settings page.`,
          });
        }
      }
      // A patch merges some values; refuse rather than store something other than the document.
      const missed = documentChanges(
        yield* settingsDocument(next, expected.defaults),
        yield* settingsDocument(expected.target, expected.defaults),
      );
      if (missed.length > 0) {
        return yield* new SettingsDocumentError({ detail: unreachableMessage(missed) });
      }
    }),
  });
  return yield* updateResult(report);
});
