export interface ConnectionPairingAutomation {
  readonly pairingUrl: string;
  readonly autoConnect: boolean;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/** The build-time pairing URL `just mobile-dev-server <url>` gives the Add environment form. */
export function resolveConnectionPairingAutomation(input: {
  readonly developmentPairingUrl?: string | undefined;
  readonly developmentAutoConnect?: string | undefined;
}): ConnectionPairingAutomation | null {
  const pairingUrl = input.developmentPairingUrl?.trim() ?? "";
  if (pairingUrl.length === 0) return null;
  return { pairingUrl, autoConnect: isEnabled(input.developmentAutoConnect) };
}
