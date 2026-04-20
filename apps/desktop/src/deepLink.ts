import type { DesktopOpenWorkspaceRequest } from "@t3tools/contracts";

const DESKTOP_DEEP_LINK_SCHEME = "t3:";
const OPEN_WORKSPACE_ACTION = "open";

function resolveDeepLinkAction(url: URL): string | null {
  const hostname = url.hostname.trim().toLowerCase();
  if (hostname.length > 0) {
    return hostname;
  }

  return (
    url.pathname
      .split("/")
      .map((segment) => segment.trim().toLowerCase())
      .find((segment) => segment.length > 0) ?? null
  );
}

export function parseDesktopDeepLink(rawUrl: string): DesktopOpenWorkspaceRequest | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== DESKTOP_DEEP_LINK_SCHEME) {
    return null;
  }

  if (resolveDeepLinkAction(url) !== OPEN_WORKSPACE_ACTION) {
    return null;
  }

  const cwd = url.searchParams.get("cwd")?.trim();
  if (!cwd) {
    return null;
  }

  return { cwd };
}
