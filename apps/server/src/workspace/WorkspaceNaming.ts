// @effect-diagnostics nodeBuiltinImport:off -- the reservation needs an exclusive create, which Effect's FileSystem does not expose.
/**
 * Names for managed workspace directories. A name is derived once from the
 * creation-time seed and never follows later title changes, because terminals,
 * tools and previews keep using the path.
 *
 * @module WorkspaceNaming
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const WORKSPACE_NAME_MAX_LENGTH = 32;
const WORKSPACE_NAME_COLLISION_LIMIT = 10_000;

export class WorkspaceNameError extends Schema.TaggedError<WorkspaceNameError>()(
  "WorkspaceNameError",
  {
    parentPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not allocate a workspace name below '${this.parentPath}'.`;
  }
}

const isWorkspaceNameError = Schema.is(WorkspaceNameError);

export function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "workspace";
}

/** Opaque but stable fallback when no semantic seed is available. */
export function fallbackWorkspaceSeed(threadId: ThreadId): string {
  const suffix = threadId
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-8)
    .toLowerCase();
  return `task-${suffix || "workspace"}`;
}

/** The directory name for a seed; numeric suffixes only appear for collisions. */
export function workspaceName(input: {
  readonly seed: string | undefined;
  readonly fallbackSeed: string;
  readonly collisionIndex?: number;
}): string {
  const collisionIndex = input.collisionIndex ?? 1;
  const suffix = collisionIndex > 1 ? `-${collisionIndex}` : "";
  const limit = WORKSPACE_NAME_MAX_LENGTH - suffix.length;
  const normalized = slug(input.seed?.trim() || input.fallbackSeed).replace(/[._]+/g, "-");
  const truncated = normalized.slice(0, limit);
  const wordBoundary = normalized.length > limit ? truncated.lastIndexOf("-") : -1;
  const name = (wordBoundary > 0 ? truncated.slice(0, wordBoundary) : truncated).replace(
    /-+$/g,
    "",
  );
  return `${name || "workspace"}${suffix}`;
}

interface WorkspaceReservation {
  readonly name: string;
  readonly path: string;
}

interface ReserveInput {
  readonly parentPath: string;
  readonly seed: string | undefined;
  readonly fallbackSeed: string;
  /** Names the VCS already uses, such as existing jj workspace names. */
  readonly unavailableNames?: ReadonlySet<string>;
  /** Paths threads still reference even if the directory disappeared. */
  readonly unavailablePaths?: ReadonlySet<string>;
}

function reserve(input: ReserveInput): WorkspaceReservation & { readonly release: () => void } {
  NodeFS.mkdirSync(input.parentPath, { recursive: true });
  for (let collisionIndex = 1; collisionIndex <= WORKSPACE_NAME_COLLISION_LIMIT; collisionIndex++) {
    const name = workspaceName({ ...input, collisionIndex });
    const path = NodePath.join(input.parentPath, name);
    if (
      input.unavailableNames?.has(name) ||
      input.unavailablePaths?.has(path) ||
      NodeFS.existsSync(path)
    ) {
      continue;
    }
    const reservationPath = NodePath.join(input.parentPath, `.${name}.t3-reservation`);
    try {
      NodeFS.writeFileSync(reservationPath, "", { flag: "wx" });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw cause;
    }
    if (NodeFS.existsSync(path)) {
      NodeFS.rmSync(reservationPath, { force: true });
      continue;
    }
    return { name, path, release: () => NodeFS.rmSync(reservationPath, { force: true }) };
  }
  throw new WorkspaceNameError({ parentPath: input.parentPath });
}

/**
 * Holds an exclusive claim on a free name while `use` creates the directory, so
 * two concurrent launches with the same seed get different names.
 */
export const withWorkspaceReservation = <A, E, R>(
  input: ReserveInput,
  use: (reservation: WorkspaceReservation) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | WorkspaceNameError, R> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => reserve(input),
      catch: (cause) =>
        isWorkspaceNameError(cause)
          ? cause
          : new WorkspaceNameError({ parentPath: input.parentPath, cause }),
    }),
    use,
    (reservation) => Effect.sync(reservation.release),
  );
