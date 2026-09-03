/**
 * Prototype routes (`/prototypes/*`) are server-free demos. The root route
 * renders them bare and the app root skips every host that would activate
 * the connection runtime, so a static build never polls for a backend.
 */
export function isPrototypePathname(pathname: string): boolean {
  return pathname.startsWith("/prototypes/");
}

/** Same check against the live browser location; false outside a browser. */
export function isPrototypeLocation(): boolean {
  return typeof window !== "undefined" && isPrototypePathname(window.location.pathname);
}
