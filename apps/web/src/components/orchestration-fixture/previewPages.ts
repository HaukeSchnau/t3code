/**
 * Self-contained docs pages for the fixture's Preview lens.
 *
 * Two workers each run a docs preview from the same checkout: Navigation
 * changed the tree and Styling changed the type scale. Both render from one
 * page generator so the two-up view compares the same content, and every
 * link posts its path to the parent so Open both can keep two frames in step.
 */
import type { FixturePreviewVariant } from "./model";

export const PREVIEW_NAV_MESSAGE = "t3-fixture-preview-nav";

export interface PreviewNavMessage {
  readonly type: typeof PREVIEW_NAV_MESSAGE;
  readonly path: string;
}

export function isPreviewNavMessage(data: unknown): data is PreviewNavMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { type?: unknown }).type === PREVIEW_NAV_MESSAGE &&
    typeof (data as { path?: unknown }).path === "string"
  );
}

interface DocsPage {
  readonly path: string;
  readonly title: string;
  readonly section: "User" | "Internals";
  readonly body: ReadonlyArray<string>;
}

export const DOCS_PAGES: ReadonlyArray<DocsPage> = [
  {
    path: "/docs/",
    title: "T3 Code",
    section: "User",
    body: [
      "<p>T3 Code is a minimal GUI for coding agents. Bring your own Codex, Claude Code, Cursor, Grok or OpenCode subscription and drive them from one place.</p>",
      "<h2>Start here</h2>",
      '<ul><li><a href="/docs/install">Install</a> the desktop app or run <code>npx t3</code>.</li><li><a href="/docs/remote">Connect remotely</a> from a phone or another machine.</li><li><a href="/docs/providers">Pick a provider</a> and start a thread.</li></ul>',
    ],
  },
  {
    path: "/docs/install",
    title: "Install",
    section: "User",
    body: [
      "<p>Download the desktop app for macOS, Windows or Linux, or run <code>npx t3</code> in a terminal to host a server and open the web app.</p>",
      "<h2>Desktop</h2><p>The desktop app bundles the server and can act as the host for remote connections.</p>",
      "<h2>Command line</h2><p>The command prints a pairing link. Open it in a browser on any device that can reach the machine.</p>",
    ],
  },
  {
    path: "/docs/remote",
    title: "Connect remotely",
    section: "User",
    body: [
      "<p>An environment is a running T3 Code server on a machine. You can connect to it from your local network, over Tailscale, or through T3 Connect.</p>",
      "<h2>Tailscale</h2><p>Install Tailscale on both devices, then open the pairing link from the host. No ports to forward.</p>",
      "<h2>T3 Connect</h2><p>T3 Connect tunnels a host to app.t3.codes so you can reach it from anywhere. Enable it from Settings, then pair.</p>",
      "<h2>Pairing</h2><p>Every device pairs once with a one-time link. The link carries a token, so hand over the whole link.</p>",
    ],
  },
  {
    path: "/docs/providers",
    title: "Providers",
    section: "User",
    body: [
      "<p>T3 Code talks to the agent runtime you already pay for. Each provider keeps its own login.</p>",
      "<h2>Codex</h2><p>Sign in with your ChatGPT account the first time a Codex thread starts.</p>",
      "<h2>Claude Code</h2><p>Uses your Claude subscription through the Claude Code CLI.</p>",
      "<h2>Cursor, Grok and OpenCode</h2><p>Each installs its own command line tool; T3 Code detects them on first launch.</p>",
    ],
  },
  {
    path: "/docs/internals/glossary",
    title: "Glossary",
    section: "Internals",
    body: [
      "<p>Shared vocabulary for contributors and agents working on T3 Code.</p>",
      "<dl><dt>environment</dt><dd>One running T3 server and the machine, filesystem, credentials and state it owns.</dd><dt>project</dt><dd>An environment-local workspace record rooted at a directory.</dd><dt>thread</dt><dd>The durable conversation and work history for a project.</dd><dt>turn</dt><dd>One user-to-agent cycle, including follow-up work such as checkpointing.</dd></dl>",
    ],
  },
  {
    path: "/docs/internals/overview",
    title: "Architecture overview",
    section: "Internals",
    body: [
      "<p>Clients send typed WebSocket requests. The server turns them into commands, a pure decider turns commands into persisted events, and a projector derives the read model the UI renders.</p>",
      "<p>Provider CLIs run as subprocesses; per-provider adapters translate their native protocols into orchestration events.</p>",
    ],
  },
];

export function normalizePreviewPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) return "/docs/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (DOCS_PAGES.some((page) => page.path === withSlash)) return withSlash;
  const withoutTrailing = withSlash.replace(/\/+$/, "");
  return DOCS_PAGES.some((page) => page.path === withoutTrailing) ? withoutTrailing : withSlash;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const BASE_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; color: #1f2328; background: #ffffff; -webkit-font-smoothing: antialiased; }
  a { color: inherit; text-decoration: none; }
  .frame { display: grid; grid-template-columns: var(--nav-width) 1fr; min-height: 100vh; }
  nav { border-right: 1px solid #e6e8eb; padding: var(--nav-pad); background: var(--nav-bg); }
  nav h3 { margin: 0 0 6px; font-size: var(--nav-heading); letter-spacing: .06em; text-transform: uppercase; color: #6b7280; }
  nav ul { list-style: none; margin: 0 0 14px; padding: 0; }
  nav li a { display: block; padding: var(--nav-row-pad); border-radius: 6px; font-size: var(--nav-size); }
  nav li a[aria-current] { background: var(--nav-active); font-weight: 600; }
  nav li a:hover { background: #f3f4f6; }
  main { padding: var(--main-pad); max-width: 46rem; }
  main h1 { margin: 0 0 12px; font-size: var(--h1); letter-spacing: -.01em; }
  main h2 { margin: 22px 0 6px; font-size: var(--h2); }
  main p, main li, main dd { font-size: var(--body); line-height: var(--leading); color: #2f3640; }
  main ul { padding-left: 1.2em; }
  main dt { font-weight: 600; font-size: var(--body); margin-top: 10px; }
  main dd { margin: 2px 0 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; background: #f3f4f6; padding: 1px 4px; border-radius: 4px; }
  main a { color: #7c3aed; border-bottom: 1px solid #ddd6fe; }
`;

const VARIANT_CSS: Record<FixturePreviewVariant, string> = {
  nav: `
    :root { --nav-width: 15rem; --nav-pad: 20px 14px; --nav-heading: 11px; --nav-size: 15px; --nav-row-pad: 6px 8px; --nav-bg: #fafafa; --nav-active: #ede9fe; --main-pad: 32px 40px; --h1: 30px; --h2: 20px; --body: 16px; --leading: 1.65; }
    body { font-family: Georgia, "Times New Roman", serif; }
  `,
  style: `
    :root { --nav-width: 13rem; --nav-pad: 12px 8px; --nav-heading: 10px; --nav-size: 13px; --nav-row-pad: 4px 8px; --nav-bg: #f6f6f7; --nav-active: #e9e5f5; --main-pad: 20px 28px; --h1: 22px; --h2: 15px; --body: 13px; --leading: 1.55; }
    body { font-family: -apple-system, "Inter", "Segoe UI", system-ui, sans-serif; }
  `,
};

/** Renders one docs page as a full HTML document for an `srcdoc` frame. */
export function renderDocsPage(variant: FixturePreviewVariant, rawPath: string): string {
  const path = normalizePreviewPath(rawPath);
  const page = DOCS_PAGES.find((entry) => entry.path === path);
  const sections: Array<DocsPage["section"]> = ["User", "Internals"];
  const nav = sections
    .map((section) => {
      const items = DOCS_PAGES.filter((entry) => entry.section === section)
        .map(
          (entry) =>
            `<li><a href="${entry.path}"${entry.path === path ? ' aria-current="page"' : ""}>${escapeHtml(entry.title)}</a></li>`,
        )
        .join("");
      return `<h3>${section}</h3><ul>${items}</ul>`;
    })
    .join("");
  const body = page
    ? `<h1>${escapeHtml(page.title)}</h1>${page.body.join("")}`
    : `<h1>Not found</h1><p>No page at <code>${escapeHtml(path)}</code>. Try <a href="/docs/">the start page</a>.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(page?.title ?? "Not found")}</title>
<style>${VARIANT_CSS[variant]}${BASE_CSS}</style></head>
<body><div class="frame"><nav>${nav}</nav><main>${body}</main></div>
<script>
  document.addEventListener("click", function (event) {
    var anchor = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!anchor) return;
    event.preventDefault();
    window.parent.postMessage({ type: ${JSON.stringify(PREVIEW_NAV_MESSAGE)}, path: anchor.getAttribute("href") }, "*");
  });
</script></body></html>`;
}
