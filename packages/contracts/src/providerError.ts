import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ProviderErrorClass = Schema.Literals([
  "provider_error",
  "provider_overloaded",
  "rate_limited",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);
export type ProviderErrorClass = typeof ProviderErrorClass.Type;

/** A provider/account condition that applies beyond the thread which observed it. */
export const ProviderUnavailable = Schema.Struct({
  type: Schema.Literal("provider_unavailable"),
  cause: Schema.Literal("rate_limited"),
  scope: Schema.Literal("provider_instance"),
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  model: Schema.optional(TrimmedNonEmptyString),
  reason: TrimmedNonEmptyString,
  retryable: Schema.Boolean,
  retryAt: Schema.NullOr(IsoDateTime),
});
export type ProviderUnavailable = typeof ProviderUnavailable.Type;

export const PROVIDER_OVERLOADED_ERROR_MESSAGE =
  "Selected model is at capacity. Please try a different model.";

/** The message check keeps overload failures persisted by older servers resumable. */
export function isProviderOverloadedError(input: {
  readonly errorClass?: ProviderErrorClass | null | undefined;
  readonly message?: string | null | undefined;
}) {
  return (
    input.errorClass === "provider_overloaded" ||
    input.message?.trim() === PROVIDER_OVERLOADED_ERROR_MESSAGE
  );
}
