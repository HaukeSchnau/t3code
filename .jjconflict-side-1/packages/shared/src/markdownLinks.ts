export interface InlineCodeWebLink {
  readonly href: string;
  readonly host: string;
}

const INLINE_CODE_URL_DISQUALIFIER_PATTERN = /[\s`]/;
const WEB_PROTOCOL_PATTERN = /^https?:\/\//i;
const IPV4_HOST_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;

// These cover the domains agents commonly print while excluding source-file
// suffixes such as `.ts`, `.rs`, and `.sh`.
const WEB_HOST_TLDS = new Set([
  "ai",
  "app",
  "at",
  "au",
  "be",
  "biz",
  "br",
  "ca",
  "cc",
  "ch",
  "chat",
  "cloud",
  "cn",
  "co",
  "com",
  "cz",
  "de",
  "dev",
  "dk",
  "edu",
  "es",
  "eu",
  "fi",
  "fr",
  "gg",
  "gov",
  "hk",
  "ie",
  "info",
  "io",
  "it",
  "jp",
  "kr",
  "link",
  "me",
  "mil",
  "mx",
  "net",
  "nl",
  "no",
  "nz",
  "online",
  "org",
  "pl",
  "pt",
  "ru",
  "se",
  "sg",
  "site",
  "store",
  "tech",
  "tr",
  "tv",
  "uk",
  "us",
  "xyz",
]);

function hasLikelyWebHost(hostname: string): boolean {
  const lowered = hostname.toLowerCase();
  if (lowered === "localhost" || IPV4_HOST_PATTERN.test(lowered)) return true;
  const labels = lowered.split(".");
  const tld = labels.at(-1);
  return labels.length >= 2 && tld !== undefined && WEB_HOST_TLDS.has(tld);
}

/**
 * Recognizes an entire inline-code span as a web URL. Bare domains are kept
 * conservative so filenames such as `index.ts` stay code instead of links.
 */
export function resolveInlineCodeWebLink(value: string): InlineCodeWebLink | null {
  const candidate = value.trim();
  if (candidate.length === 0 || INLINE_CODE_URL_DISQUALIFIER_PATTERN.test(candidate)) return null;

  const hasProtocol = WEB_PROTOCOL_PATTERN.test(candidate);
  const input = hasProtocol ? candidate : `https://${candidate}`;
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!hasProtocol && !hasLikelyWebHost(url.hostname)) return null;
    return { href: url.toString(), host: url.hostname };
  } catch {
    return null;
  }
}
