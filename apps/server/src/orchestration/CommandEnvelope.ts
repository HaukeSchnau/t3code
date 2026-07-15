// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

/** Canonical JSON shared by durable receipts and preprocessing progress. */
export function canonicalCommandJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalCommandJson(item))).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalCommandJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new TypeError(`Unsupported canonical command value: ${typeof value}`);
}

export function commandEnvelopeFingerprint(command: unknown): string {
  return NodeCrypto.createHash("sha256").update(canonicalCommandJson(command)).digest("hex");
}
