import { useAtomValue } from "@effect/atom-react";
import {
  projectEnvironmentConnectionFreshness,
  type EnvironmentConnectionFreshnessProjection,
} from "@t3tools/client-runtime/state/connection-freshness";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { environmentShell } from "./shell";

const EMPTY_PROJECTION_ATOM = Atom.make<EnvironmentConnectionFreshnessProjection | null>(null).pipe(
  Atom.withLabel("mobile:connection-freshness:empty"),
);

const connectionFreshnessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): EnvironmentConnectionFreshnessProjection | null => {
    const connectionResult = get(environmentCatalog.stateAtom(environmentId));
    const connection = Option.getOrNull(AsyncResult.value(connectionResult));
    if (connection === null) return null;
    return projectEnvironmentConnectionFreshness(
      connection,
      get(environmentShell.stateValueAtom(environmentId)),
    );
  }).pipe(Atom.withLabel(`mobile:connection-freshness:${environmentId}`)),
);

export function useEnvironmentConnectionFreshness(
  environmentId: EnvironmentId | null,
): EnvironmentConnectionFreshnessProjection | null {
  return useAtomValue(
    environmentId === null ? EMPTY_PROJECTION_ATOM : connectionFreshnessAtom(environmentId),
  );
}
