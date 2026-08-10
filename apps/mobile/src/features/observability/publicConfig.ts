import Constants from "expo-constants";

export interface TracingPublicConfig {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  readonly tracesToken: string;
}

interface UntrustedExpoExtra {
  readonly observability?: {
    readonly tracesUrl?: unknown;
    readonly tracesDataset?: unknown;
    readonly tracesToken?: unknown;
  };
}

function trimNonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSecureUrl(value: unknown): string | null {
  const raw = trimNonEmpty(value);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveTracingPublicConfig(
  extra: UntrustedExpoExtra | null | undefined = Constants.expoConfig?.extra,
): TracingPublicConfig | null {
  const observability = extra?.observability;
  const tracesUrl = normalizeSecureUrl(observability?.tracesUrl);
  const tracesDataset = trimNonEmpty(observability?.tracesDataset);
  const tracesToken = trimNonEmpty(observability?.tracesToken);
  return tracesUrl && tracesDataset && tracesToken
    ? { tracesUrl, tracesDataset, tracesToken }
    : null;
}
