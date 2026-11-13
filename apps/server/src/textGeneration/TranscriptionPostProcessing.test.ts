import { describe, expect, it } from "vite-plus/test";

import {
  buildTranscriptionPostProcessingPrompt,
  buildVoiceCommandPrompt,
} from "./TranscriptionPostProcessing.ts";

describe("buildTranscriptionPostProcessingPrompt", () => {
  it("names the correction cue only when the person set one", () => {
    const draft = { text: "Make it 42.", selection: { start: 11, end: 11 } };
    const plain = buildTranscriptionPostProcessingPrompt("Clean.", "sorry 24", draft);
    expect(plain).not.toContain("Correction cue");
    expect(plain.startsWith("Clean.\n\n<transcript>")).toBe(true);
    const cued = buildTranscriptionPostProcessingPrompt("Clean.", "sorry 24", draft, ' so"rry ');
    expect(cued).toContain('Correction cue: "so\\"rry".');
    expect(cued.indexOf("Correction cue")).toBeLessThan(cued.indexOf("<transcript>"));
  });

  it("names the app outside T3 that receives the text", () => {
    const draft = { text: "", selection: { start: 0, end: 0 } };
    expect(buildTranscriptionPostProcessingPrompt("Clean.", "hi", draft)).not.toContain(
      "outside T3",
    );
    expect(buildTranscriptionPostProcessingPrompt("Clean.", "hi", draft, "", "Slack")).toContain(
      'a field in "Slack", outside T3 Code',
    );
  });
});

describe("buildVoiceCommandPrompt", () => {
  it("rewrites a selection, or writes at the cursor when nothing is selected", () => {
    const text = "Hi Sam, see you at 5. Thanks";
    const rewrite = buildVoiceCommandPrompt(
      "make it more formal",
      { text, selection: { start: 0, end: 21 } },
      "Mail",
    );
    expect(rewrite).toContain("<composer_selection>\nHi Sam, see you at 5.\n</composer_selection>");
    expect(rewrite).toContain("Return only the replacement for the selection.");
    expect(rewrite).toContain('a field in "Mail"');

    const write = buildVoiceCommandPrompt("say I'll be late", {
      text,
      selection: { start: 21, end: 21 },
    });
    expect(write).not.toContain("<composer_selection>");
    expect(write).toContain("inserted at the cursor");
    expect(write).toContain("<composer_before>\nHi Sam, see you at 5.\n</composer_before>");
  });
});
