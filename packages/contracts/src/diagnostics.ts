import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WorkloadDiagnosticsSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  startedAtIso: IsoDateTime,
  readAtIso: IsoDateTime,
  counters: Schema.Record(TrimmedNonEmptyString, NonNegativeInt),
  gauges: Schema.Record(TrimmedNonEmptyString, NonNegativeInt),
});
export type WorkloadDiagnosticsSnapshot = typeof WorkloadDiagnosticsSnapshot.Type;
