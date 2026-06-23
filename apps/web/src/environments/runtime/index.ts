import type { EnvironmentId } from "@t3tools/contracts";

import { readPreparedConnection } from "../../state/session";

export function resolveEnvironmentHttpUrl(input: {
  readonly environmentId: EnvironmentId;
  readonly pathname: string;
  readonly searchParams?: Readonly<Record<string, string>>;
}): string {
  const connection = readPreparedConnection(input.environmentId);
  if (!connection) {
    throw new Error(`Environment ${input.environmentId} is not connected.`);
  }

  const url = new URL(input.pathname, connection.httpBaseUrl);
  for (const [key, value] of Object.entries(input.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
