import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Suffix added by the server when a detail string is shortened for the wire. */
export const TRANSPORT_TRUNCATION_SUFFIX = "\n… output truncated for transport";

/**
 * Formats the source version used to invalidate an on-demand detail snapshot.
 * Keep malformed legacy fixtures renderable while native items use real UTC values.
 */
export function turnItemUpdatedAtKey(updatedAt: DateTime.Utc): string {
  try {
    return DateTime.formatIso(updatedAt);
  } catch {
    return "invalid";
  }
}

export function isTransportTruncatedText(value: string | null | undefined): boolean {
  return value?.endsWith(TRANSPORT_TRUNCATION_SUFFIX) === true;
}

function isTransportTruncatedValue(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && "truncated" in value && value.truncated === true
  );
}

/**
 * Tells detail renderers whether the projection contains a transport preview.
 * The persisted native item remains complete and can be fetched by its item or provider turn.
 */
export function isTurnItemDetailTruncated(item: OrchestrationV2TurnItem): boolean {
  switch (item.type) {
    case "command_execution":
      return isTransportTruncatedText(item.output);
    case "file_change":
      return (
        isTransportTruncatedText(item.diffStr) ||
        isTransportTruncatedText(item.oldStr) ||
        isTransportTruncatedText(item.newStr)
      );
    case "subagent":
      return (
        isTransportTruncatedText(item.prompt) ||
        isTransportTruncatedText(item.progress) ||
        isTransportTruncatedText(item.result)
      );
    case "dynamic_tool":
      return isTransportTruncatedValue(item.input) || isTransportTruncatedValue(item.output);
    default:
      return false;
  }
}
