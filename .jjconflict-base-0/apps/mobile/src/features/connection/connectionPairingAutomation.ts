export interface ConnectionPairingAutomation {
  readonly pairingUrl: string;
  readonly autoConnect: boolean;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function resolveConnectionPairingAutomation(input: {
  readonly routePairingUrl?: string | undefined;
  readonly routeAutoConnect?: string | undefined;
  readonly developmentPairingUrl?: string | undefined;
  readonly developmentAutoConnect?: string | undefined;
}): ConnectionPairingAutomation | null {
  const routePairingUrl = input.routePairingUrl?.trim() ?? "";
  if (routePairingUrl.length > 0) {
    return {
      pairingUrl: routePairingUrl,
      autoConnect: isEnabled(input.routeAutoConnect),
    };
  }

  const pairingUrl = input.developmentPairingUrl?.trim() ?? "";
  if (pairingUrl.length === 0) return null;

  return {
    pairingUrl,
    autoConnect: isEnabled(input.developmentAutoConnect),
  };
}
