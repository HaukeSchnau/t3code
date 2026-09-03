import {
  fileBasename,
  formatFilePathPosition,
  inlineCodeFilePathCandidate,
  isRelativeFilePath,
  normalizeMarkdownLinkDestination,
  parseFileUrlHref,
  parseMarkdownFileLink,
  safeDecodeURIComponent,
  splitFilePathPosition,
  workspaceRelativeFilePath,
} from "@t3tools/client-runtime/markdown-links";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { isTerminalLinkActivation, resolvePathLinkTarget } from "./terminal-links";

export { normalizeMarkdownLinkDestination };

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;
const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
const RELATIVE_FILE_PATH_PATTERN =
  /^(?:[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*\/)+[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*(?::\d+){0,2}$/;
const RELATIVE_FILE_NAME_PATTERN =
  /^[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
const MARKDOWN_IMAGE_FILE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);
// Standard OS and dev-container roots; deliberately excludes app-route-ish
// prefixes like /app/ or /chat/ so SPA routes never read as files.
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/lib/",
  "/lib64/",
  "/srv/",
  "/dev/",
  "/proc/",
  "/sys/",
  "/run/",
  "/boot/",
  "/media/",
  "/workspace/",
  "/workspaces/",
] as const;
const MARKDOWN_LINK_HREF_PATTERN =
  /\[[^\]]*]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
}

export function extractMarkdownLinkHrefs(markdown: string): string[] {
  const hrefs: string[] = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = (match[1] ?? match[2])?.trim();
    if (href) hrefs.push(href);
  }
  return hrefs;
}

export function shouldOpenMarkdownFileLinkInEditor(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform?: string,
): boolean {
  return isTerminalLinkActivation(event, platform);
}

export function shouldOpenMarkdownFileLinkInBrowserByDefault(path: string): boolean {
  return /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");
}

export function isWindowsDrivePathHref(href: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(safeDecodeURIComponent(href));
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(normalizeMarkdownLinkDestination(href));
  return target ? `${target.path}${target.hash}` : null;
}

function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = pathWithSearch.indexOf("?");
  return {
    path: queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch,
    hash: hashIndex >= 0 ? value.slice(hashIndex) : "",
  };
}

function normalizeWindowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function isLikelyPathCandidate(path: string): boolean {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(path) || WINDOWS_UNC_PATH_PATTERN.test(path)) return true;
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(path);
  return RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function isRelativePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") &&
      !WINDOWS_DRIVE_PATH_PATTERN.test(path) &&
      !WINDOWS_UNC_PATH_PATTERN.test(path))
  );
}

function hasExternalScheme(path: string): boolean {
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  return rest.startsWith("//") || !POSITION_ONLY_PATTERN.test(rest);
}

/**
 * `baseDir` anchors relative links; it defaults to the workspace root and is the
 * file's own directory when rendering a markdown file. `cwd` stays the workspace
 * root so the result still knows whether the target is inside it.
 */
export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): string | null {
  if (!href) return null;
  const target = parseMarkdownFileLink(href);
  if (!target) return null;

  const pathWithPosition = formatFilePathPosition(target);
  if (!isRelativeFilePath(pathWithPosition)) return pathWithPosition;
  if (!baseDir) return null;
  return resolvePathLinkTarget(pathWithPosition, baseDir);
}

function hasMarkdownImageExtension(path: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const basename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  const extensionMatch = /\.([A-Za-z0-9]{1,8})$/.exec(basename);
  return extensionMatch
    ? MARKDOWN_IMAGE_FILE_EXTENSIONS.has(`.${extensionMatch[1]!.toLowerCase()}`)
    : false;
}

export function resolveMarkdownImageFileSource(
  src: string | undefined,
  cwd?: string,
): string | null {
  if (!src) return null;
  const rawSrc = normalizeMarkdownLinkDestination(src);
  if (rawSrc.length === 0 || rawSrc.startsWith("#")) return null;

  const fileUrlTarget = rawSrc.toLowerCase().startsWith("file:") ? parseFileUrlHref(rawSrc) : null;
  const source = fileUrlTarget ?? stripSearchAndHash(rawSrc);
  const decodedPath = normalizeWindowsDrivePath(
    fileUrlTarget ? source.path.trim() : safeDecodeURIComponent(source.path.trim()),
  );

  if (decodedPath.length === 0) return null;
  if (
    !WINDOWS_DRIVE_PATH_PATTERN.test(decodedPath) &&
    !WINDOWS_UNC_PATH_PATTERN.test(decodedPath) &&
    hasExternalScheme(decodedPath)
  ) {
    return null;
  }
  if (!isLikelyPathCandidate(decodedPath) || !hasMarkdownImageExtension(decodedPath)) {
    return null;
  }
  if (!isRelativePath(decodedPath)) {
    return decodedPath;
  }
  if (!cwd) return null;
  return resolvePathLinkTarget(decodedPath, cwd);
}

const INLINE_CODE_DISQUALIFIER_PATTERN = /[\s`]/;
const PATH_SEPARATOR_PATTERN = /[\\/]/;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9_-]+$/;
const NUMERIC_DOTTED_PATTERN = /^\d+(?:\.\d+)+$/;
const BARE_EXTENSIONLESS_POSITION_PATTERN = /^[A-Za-z0-9_-]+(?::\d+){1,2}$/;
// Any `Name:digits` shape also matches `error:1`, `port:3000`, `TODO:12`, so
// extensionless linking is limited to conventional filenames.
const EXTENSIONLESS_FILE_NAMES = new Set([
  "Makefile",
  "makefile",
  "GNUmakefile",
  "Dockerfile",
  "Containerfile",
  "Justfile",
  "justfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Brewfile",
  "Caddyfile",
  "Vagrantfile",
  "Jenkinsfile",
  "Podfile",
  "Fastfile",
  "BUILD",
  "WORKSPACE",
  "LICENSE",
  "LICENCE",
  "COPYING",
  "NOTICE",
  "AUTHORS",
  "CONTRIBUTORS",
  "CHANGELOG",
  "README",
  "CODEOWNERS",
]);
const SINGLE_LABEL_HOSTNAMES = new Set(["localhost"]);
// Allowlists, not full public-suffix detection: treating every dotted first
// segment as a host would swallow real paths like `conf.d/x.conf` or
// `Makefile.in:12`. Extensions that double as filename suffixes (`sh`, `md`,
// `ts`, `rs`, `in`, ...) are deliberately absent from both sets.
const GENERIC_HOSTNAME_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "dev",
  "app",
  "ai",
  "co",
  "edu",
  "gov",
  "mil",
  "info",
  "biz",
  "xyz",
  "me",
  "tv",
  "cc",
  "gg",
  "chat",
  "cloud",
  "site",
  "online",
  "tech",
  "store",
  "link",
]);
// Country codes collide with file extensions (`.pl` Perl, `.pt` PyTorch,
// `.es` ES modules), so they only count as host evidence when the candidate
// lacks a :line suffix — an explicit line reference marks a file and wins.
const COUNTRY_HOSTNAME_TLDS = new Set([
  "uk",
  "de",
  "fr",
  "nl",
  "se",
  "no",
  "fi",
  "dk",
  "pl",
  "ch",
  "at",
  "be",
  "es",
  "it",
  "pt",
  "eu",
  "us",
  "ca",
  "au",
  "nz",
  "jp",
  "kr",
  "cn",
  "br",
  "ru",
  "mx",
  "ie",
  "cz",
  "tr",
  "sg",
  "hk",
]);

/** `127.0.0.1`, `localhost`, `example.com`, `1.2.3` — hosts and versions, not files. */
function looksLikeHostname(segment: string, hasPosition: boolean): boolean {
  if (segment.startsWith(".")) return false;
  const lowered = segment.toLowerCase();
  if (SINGLE_LABEL_HOSTNAMES.has(lowered)) return true;
  if (NUMERIC_DOTTED_PATTERN.test(segment)) return true;
  const labels = lowered.split(".");
  const lastLabel = labels[labels.length - 1];
  if (labels.length < 2 || lastLabel === undefined) return false;
  if (GENERIC_HOSTNAME_TLDS.has(lastLabel)) return true;
  return !hasPosition && COUNTRY_HOSTNAME_TLDS.has(lastLabel);
}

/**
 * Inline code spans mostly hold identifiers, commands, and refs (`node.meta`,
 * `origin/main`) rather than deliberate link destinations, so auto-linking
 * them demands stronger path evidence than an explicit markdown link does:
 * an unambiguous path prefix, a file extension, or a :line suffix.
 */
export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const candidate = inlineCodeFilePathCandidate(codeText);
  if (candidate === null) return null;

  return resolveMarkdownFileLinkMeta(candidate, cwd, baseDir);
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd, baseDir);
  if (!targetPath) return null;
  return buildFileLinkMetaFromTarget(targetPath, cwd);
}

function buildFileLinkMetaFromTarget(targetPath: string, cwd?: string): MarkdownFileLinkMeta {
  const { path, line, column } = splitFilePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}
