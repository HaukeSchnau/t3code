import type { ThreadAskCase } from "./cases.ts";

export interface ThreadAskVerdict {
  readonly pass: boolean;
  readonly reason: string | null;
}

/** A waiting turn needs a usable ask line naming its subject; a control must not wait. */
export function gradeThreadAsk(
  testCase: Pick<ThreadAskCase, "waits" | "ask">,
  result: { readonly waitsOnUser: boolean; readonly ask: string },
): ThreadAskVerdict {
  if (!testCase.waits) {
    return result.waitsOnUser
      ? { pass: false, reason: "marked a turn that does not wait as waiting" }
      : { pass: true, reason: null };
  }
  if (!result.waitsOnUser) return { pass: false, reason: "missed that the turn waits" };
  if (result.ask === "") return { pass: false, reason: "waits, but gave no ask" };
  if (result.ask.length > 120 || /\n/.test(result.ask)) {
    return { pass: false, reason: "ask is not one line under 120 characters" };
  }
  if (/^the agent\b/i.test(result.ask)) {
    return { pass: false, reason: "ask describes the agent instead of the user's step" };
  }
  if (testCase.ask !== undefined && !testCase.ask.test(result.ask)) {
    return { pass: false, reason: "ask does not name the subject" };
  }
  return { pass: true, reason: null };
}

/**
 * A case fails when half or more of its samples fail. A sample that errored counts as failed, so
 * one passing sample cannot carry a case whose other samples never finished.
 */
export function casePasses(samples: ReadonlyArray<ThreadAskVerdict>): boolean {
  return samples.length > 0 && samples.filter((sample) => !sample.pass).length * 2 < samples.length;
}
