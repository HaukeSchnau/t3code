import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";

import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "./pairingUrl";

const LOCAL_NETWORK_DENIAL_PATTERNS = [
  "LocalNetworkAccessPermissionDenied",
  "local address space",
  "private network access",
  "Access to fetch",
] as const;

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
  readonly environmentId: string | null;
}

export type HostedAppChannel = "latest" | "nightly";

export function configuredHostedAppUrl(): string {
  return import.meta.env.VITE_HOSTED_APP_URL?.trim() || DEFAULT_HOSTED_APP_URL;
}

function configuredBackendUrl(): string {
  return import.meta.env.VITE_HTTP_URL?.trim() || import.meta.env.VITE_WS_URL?.trim() || "";
}

function configuredHostedAppChannel(): HostedAppChannel | null {
  const channel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();
  return channel === "latest" || channel === "nightly" ? channel : null;
}

function originFromUrl(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isHostedStaticApp(url?: URL): boolean {
  if (configuredBackendUrl()) {
    return false;
  }

  if (configuredHostedAppChannel()) {
    return true;
  }

  // No window (tests, static render) means no origin to be hosted at.
  if (url === undefined && typeof window === "undefined") {
    return false;
  }

  const hostedOrigin = originFromUrl(configuredHostedAppUrl());
  return hostedOrigin !== null && (url ?? new URL(window.location.href)).origin === hostedOrigin;
}

export function readHostedPairingRequest(url: URL = new URL(window.location.href)) {
  const environmentId = url.searchParams.get("environmentId")?.trim() ?? "";
  const host = url.searchParams.get("host")?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get("label")?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    host,
    token,
    label,
    environmentId: environmentId || null,
  } satisfies HostedPairingRequest;
}

export function hasHostedPairingRequest(url: URL = new URL(window.location.href)): boolean {
  return readHostedPairingRequest(url) !== null;
}

export function buildHostedPairingUrl(input: {
  readonly host: string;
  readonly token: string;
  readonly label?: string | null;
  readonly environmentId?: string | null;
}): string {
  const url = new URL("/pair", configuredHostedAppUrl());
  url.searchParams.set("host", input.host);

  const environmentId = input.environmentId?.trim();
  if (environmentId) {
    url.searchParams.set("environmentId", environmentId);
  }

  const label = input.label?.trim();
  if (label) {
    url.searchParams.set("label", label);
  }

  return setPairingTokenOnUrl(url, input.token).toString();
}

export function buildDirectHostedPairingUrl(input: {
  readonly host: string;
  readonly token: string;
}): string | null {
  const trimmedHost = input.host.trim();
  if (!trimmedHost) {
    return null;
  }

  const normalizedHost =
    /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(trimmedHost) || trimmedHost.startsWith("//")
      ? trimmedHost
      : `https://${trimmedHost}`;

  try {
    const url = new URL("/pair", normalizedHost);
    url.search = "";
    return setPairingTokenOnUrl(url, input.token).toString();
  } catch {
    return null;
  }
}

function collectErrorText(error: unknown, seen = new Set<unknown>()): string {
  if (error === null || error === undefined || seen.has(error)) {
    return "";
  }
  seen.add(error);

  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    const cause = "cause" in error ? collectErrorText(error.cause, seen) : "";
    return `${error.name} ${error.message} ${cause}`;
  }
  if (typeof error === "object") {
    const cause = "cause" in error ? collectErrorText(error.cause, seen) : "";
    return `${String(error)} ${cause}`;
  }
  return String(error);
}

export function isHostedPairingBrowserNetworkDenied(error: unknown): boolean {
  const errorText = collectErrorText(error);
  return LOCAL_NETWORK_DENIAL_PATTERNS.some((pattern) => errorText.includes(pattern));
}

export function buildHostedChannelSelectionUrl(input: {
  readonly channel: HostedAppChannel;
}): string {
  const url = new URL("/__t3code/channel", configuredHostedAppUrl());
  url.searchParams.set("channel", input.channel);
  return url.toString();
}
