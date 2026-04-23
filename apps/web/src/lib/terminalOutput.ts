export interface TerminalViewportSnapshot {
  scrollTop: number;
  atBottom: boolean;
}

const ESCAPE = "\u001b";
const BACKSPACE = "\b";
const CARRIAGE_RETURN = "\r";
const NEWLINE = "\n";
const BELL = "\u0007";

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ensureCursor(line: string[], cursor: number): void {
  while (line.length < cursor) {
    line.push(" ");
  }
}

function writeAtCursor(line: string[], cursor: number, value: string): number {
  ensureCursor(line, cursor);
  line[cursor] = value;
  return cursor + 1;
}

function eraseInLine(line: string[], cursor: number, mode: number): string[] {
  if (mode === 1) {
    const next = [...line];
    for (let index = 0; index < cursor; index += 1) {
      next[index] = " ";
    }
    return next;
  }

  if (mode === 2) {
    return [];
  }

  return line.slice(0, cursor);
}

function trimTrailingWhitespace(line: string): string {
  return line.replace(/[ \t]+$/u, "");
}

export function renderTerminalOutput(value: string): string {
  if (value.length === 0) {
    return value;
  }

  const lines: string[] = [];
  let currentLine: string[] = [];
  let cursor = 0;

  const flushLine = () => {
    lines.push(trimTrailingWhitespace(currentLine.join("")));
    currentLine = [];
    cursor = 0;
  };

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;

    if (char === ESCAPE) {
      const next = value[index + 1];

      if (next === "[") {
        let sequenceEnd = index + 2;
        while (sequenceEnd < value.length && !/[A-Za-z@`~]/u.test(value[sequenceEnd]!)) {
          sequenceEnd += 1;
        }
        const finalChar = value[sequenceEnd];
        if (!finalChar) {
          break;
        }
        const parameters = value.slice(index + 2, sequenceEnd);
        const [firstParam] = parameters.split(";");

        switch (finalChar) {
          case "m":
          case "h":
          case "l":
            break;
          case "K":
            currentLine = eraseInLine(currentLine, cursor, parseNumber(firstParam, 0));
            if (firstParam === "2") {
              cursor = 0;
            }
            break;
          case "G":
            cursor = Math.max(0, parseNumber(firstParam, 1) - 1);
            break;
          case "C":
            cursor += parseNumber(firstParam, 1);
            break;
          case "D":
            cursor = Math.max(0, cursor - parseNumber(firstParam, 1));
            break;
          case "P": {
            const count = Math.max(1, parseNumber(firstParam, 1));
            currentLine.splice(cursor, count);
            break;
          }
          case "J":
            if (parseNumber(firstParam, 0) >= 2) {
              lines.length = 0;
              currentLine = [];
              cursor = 0;
            }
            break;
          default:
            break;
        }

        index = sequenceEnd;
        continue;
      }

      if (next === "]") {
        let sequenceEnd = index + 2;
        while (sequenceEnd < value.length) {
          const current = value[sequenceEnd]!;
          if (current === BELL) {
            break;
          }
          if (current === ESCAPE && value[sequenceEnd + 1] === "\\") {
            sequenceEnd += 1;
            break;
          }
          sequenceEnd += 1;
        }
        index = sequenceEnd;
        continue;
      }

      if (next === "c") {
        lines.length = 0;
        currentLine = [];
        cursor = 0;
        index += 1;
        continue;
      }

      continue;
    }

    if (char === CARRIAGE_RETURN) {
      cursor = 0;
      continue;
    }

    if (char === NEWLINE) {
      flushLine();
      continue;
    }

    if (char === BACKSPACE) {
      cursor = Math.max(0, cursor - 1);
      continue;
    }

    cursor = writeAtCursor(currentLine, cursor, char);
  }

  const trailingLine = trimTrailingWhitespace(currentLine.join(""));
  if (trailingLine.length > 0 || lines.length === 0) {
    lines.push(trailingLine);
  }

  return lines.join("\n");
}

export function captureTerminalViewportSnapshot(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): TerminalViewportSnapshot {
  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  return {
    scrollTop: metrics.scrollTop,
    atBottom: maxScrollTop - metrics.scrollTop <= 12,
  };
}

export function resolveTerminalViewportScrollTop(input: {
  previous: TerminalViewportSnapshot;
  nextScrollHeight: number;
  clientHeight: number;
}): number {
  const maxScrollTop = Math.max(0, input.nextScrollHeight - input.clientHeight);
  if (input.previous.atBottom) {
    return maxScrollTop;
  }
  return Math.min(input.previous.scrollTop, maxScrollTop);
}
