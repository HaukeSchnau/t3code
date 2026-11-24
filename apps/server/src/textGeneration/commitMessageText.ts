/** Caps a prompt section so one huge diff cannot crowd out the rest. */
export function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

// A backstop for models that ignore the preset's lowercase instruction; acronyms and names like GitHub are left alone.
const CONVENTIONAL_CAPITALIZED_DESCRIPTION =
  /^([a-z]+(?:\([^)\n]*\))?!?: )([A-Z][a-z]*)(?![A-Za-z0-9])/;

/** Keeps a generated subject to one short line without a trailing period. */
export function sanitizeCommitMessage(
  generated: {
    subject: string;
    body: string;
    branch?: string | undefined;
  },
  conventionalCommits = false,
): {
  subject: string;
  body: string;
  branch?: string | undefined;
} {
  const rawSubject = generated.subject.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const trimmedSubject = rawSubject.replace(/[.]+$/g, "").trim();
  const subject = conventionalCommits
    ? trimmedSubject.replace(
        CONVENTIONAL_CAPITALIZED_DESCRIPTION,
        (_, prefix: string, word: string) => prefix + word.toLowerCase(),
      )
    : trimmedSubject;
  const safeSubject = subject.length > 0 ? subject.slice(0, 72).trimEnd() : "Update project files";
  return {
    subject: safeSubject,
    body: generated.body.trim(),
    ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
  };
}
