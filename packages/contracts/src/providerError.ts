import * as Schema from "effect/Schema";

export const ProviderErrorClass = Schema.Literals([
  "provider_error",
  "provider_overloaded",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
]);
export type ProviderErrorClass = typeof ProviderErrorClass.Type;

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
