// Fork: `t3 settings` and its routes (patches/settings-cli.md).
import * as Schema from "effect/Schema";

import { ServerSettings } from "./settings.ts";

/** A settings.json-shaped document: the stored, patchable values that differ from the defaults. */
export const StoredSettingsDocument = Schema.Record(Schema.String, Schema.Unknown);
export type StoredSettingsDocument = typeof StoredSettingsDocument.Type;

export const ServerSettingsSnapshot = Schema.Struct({
  /** Effective settings, redacted for a client that reads secret references. */
  settings: ServerSettings,
  stored: StoredSettingsDocument,
});
export type ServerSettingsSnapshot = typeof ServerSettingsSnapshot.Type;

/** A document path whose value changed; a missing side means the default. */
export const StoredSettingsChange = Schema.Struct({
  path: Schema.Array(Schema.String),
  before: Schema.optionalKey(Schema.Unknown),
  after: Schema.optionalKey(Schema.Unknown),
});
export type StoredSettingsChange = typeof StoredSettingsChange.Type;

export const StoredSecretChange = Schema.Struct({
  secret: Schema.String,
  change: Schema.Literals(["set", "removed"]),
});
export type StoredSecretChange = typeof StoredSecretChange.Type;

export const ServerSettingsUpdateResult = Schema.Struct({
  changes: Schema.Array(StoredSettingsChange),
  secrets: Schema.Array(StoredSecretChange),
  /** False for a dry run and when nothing changed. */
  written: Schema.Boolean,
});
export type ServerSettingsUpdateResult = typeof ServerSettingsUpdateResult.Type;

export const ServerSettingsApplyInput = Schema.Struct({
  desired: StoredSettingsDocument,
  /** The previously applied document; only paths where `desired` differs from it change. */
  base: Schema.optionalKey(StoredSettingsDocument),
  dryRun: Schema.Boolean,
});
export type ServerSettingsApplyInput = typeof ServerSettingsApplyInput.Type;
