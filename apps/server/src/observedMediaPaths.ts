// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

export const OBSERVED_MEDIA_ROUTE_PREFIX = "/observed-media";

export function normalizeObservedMediaRelativePath(rawRelativePath: string): string | null {
  const normalized = NodePath.normalize(rawRelativePath).replace(/^[/\\]+/, "");
  if (normalized.length === 0 || normalized.startsWith("..") || normalized.includes("\0")) {
    return null;
  }
  return normalized.replace(/\\/g, "/");
}

export function resolveObservedMediaRelativePath(input: {
  readonly observedMediaDir: string;
  readonly relativePath: string;
}): string | null {
  const normalizedRelativePath = normalizeObservedMediaRelativePath(input.relativePath);
  if (!normalizedRelativePath) {
    return null;
  }

  const observedMediaRoot = NodePath.resolve(input.observedMediaDir);
  const filePath = NodePath.resolve(NodePath.join(observedMediaRoot, normalizedRelativePath));
  if (!filePath.startsWith(`${observedMediaRoot}${NodePath.sep}`)) {
    return null;
  }
  return filePath;
}
