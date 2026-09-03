export const MONITOR_PATHNAME = "/monitor";
const DEFAULT_MONITOR_RETURN_HREF = "/";

let monitorReturnHref: string | null = null;

export interface AppLocationParts {
  readonly pathname: string;
  readonly searchStr?: string;
  readonly hash?: string;
}

export interface MonitorToggleTarget {
  readonly to: string;
  readonly replace: boolean;
}

export function isMonitorPathname(pathname: string): boolean {
  return pathname === MONITOR_PATHNAME;
}

export function appHrefFromLocation(location: AppLocationParts): string {
  return `${location.pathname}${location.searchStr ?? ""}${location.hash ?? ""}`;
}

function pathnameFromAppHref(href: string): string {
  const queryIndex = href.indexOf("?");
  const hashIndex = href.indexOf("#");
  const end =
    queryIndex === -1
      ? hashIndex === -1
        ? href.length
        : hashIndex
      : hashIndex === -1
        ? queryIndex
        : Math.min(queryIndex, hashIndex);
  return href.slice(0, end);
}

function normalizeReturnHref(href: string | null | undefined): string {
  if (!href || isMonitorPathname(pathnameFromAppHref(href))) {
    return DEFAULT_MONITOR_RETURN_HREF;
  }
  return href;
}

export function rememberMonitorReturnLocation(location: AppLocationParts): void {
  if (isMonitorPathname(location.pathname)) {
    return;
  }
  monitorReturnHref = appHrefFromLocation(location);
}

export function resolveMonitorToggleTarget(pathname: string): MonitorToggleTarget {
  if (isMonitorPathname(pathname)) {
    return {
      to: normalizeReturnHref(monitorReturnHref),
      replace: true,
    };
  }

  return {
    to: MONITOR_PATHNAME,
    replace: false,
  };
}

export function resetMonitorReturnLocationForTest(): void {
  monitorReturnHref = null;
}
