/** Published task documents open beside their conversation. Other links keep their usual action. */
export function parseArtifactLink(href: string) {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (
    url.origin !== "https://files.schnau.dev" ||
    url.username ||
    url.password ||
    url.pathname === "/"
  ) {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const name = path.replace(/\/$/, "").split("/").at(-1) ?? "Artifact";
  // Extensionless routes and directories can be published HTML apps. Known
  // document extensions render in the browser; media keeps its existing viewer.
  if (
    !path.endsWith("/") &&
    name.includes(".") &&
    !/\.(?:html?|pdf|txt|md|markdown|json)$/i.test(name)
  ) {
    return null;
  }
  return { url: url.href, title: name };
}

export function shouldOpenArtifactInPanel(event: {
  readonly defaultPrevented: boolean;
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** A new document URL bypasses the browser's cached iframe navigation after an agent edits it. */
export function artifactReloadUrl(href: string, revision: number): string {
  const url = new URL(href);
  url.searchParams.set("_t3_reload", String(revision));
  return url.href;
}
