const quoteCue = (cue: string) => JSON.stringify(cue);

type Draft = {
  readonly text: string;
  readonly selection: { readonly start: number; readonly end: number };
};

const targetAppLine = (targetApp: string | undefined) => {
  const app = targetApp?.trim();
  return app
    ? `\n\nThe text goes into a field in ${JSON.stringify(app)}, outside T3 Code. The composer tags below hold that field's text. Follow that app's conventions.`
    : "";
};

/** Builds the cleanup prompt: instructions, the transcript, and the draft around the insertion point. */
export function buildTranscriptionPostProcessingPrompt(
  instructions: string,
  transcript: string,
  draft: Draft,
  correctionCue = "",
  targetApp?: string,
): string {
  const cue = correctionCue.trim();
  const cueInstructions = cue
    ? `\n\nCorrection cue: ${quoteCue(cue)}. Only when this cue clearly marks a spoken self-correction, apply the correction the speaker made and omit the cue from the result. The correction may revise, add to, or retract earlier speech. Preserve everything else. If the cue is an intended part of the sentence, keep it. Use the surrounding context to decide; do not assume every occurrence is a correction.`
    : "";
  const cursor = Math.max(0, Math.min(draft.selection.start, draft.text.length));
  const selectionEnd = Math.max(cursor, Math.min(draft.selection.end, draft.text.length));
  const replacesSelection = selectionEnd > cursor;
  const placement = replacesSelection
    ? "The transcript will replace composer_selection between composer_before and composer_after. Use the selected text only as context for terminology and references; it will not remain in the draft. Do not preserve or copy it into the result unless the new speech itself says it."
    : "The transcript will be inserted at the cursor between composer_before and composer_after.";
  const selectionBlock = replacesSelection
    ? `\n<composer_selection>\n${draft.text.slice(cursor, selectionEnd)}\n</composer_selection>`
    : "";
  return `${instructions}${cueInstructions}${targetAppLine(targetApp)}

<transcript>
${transcript}
</transcript>

${placement} Use the composer draft and insertion position to resolve ambiguity and correct likely recognition errors in the transcript. The draft can clarify the topic, references, terminology, and how the new speech fits with nearby text. Prefer an interpretation supported by the draft when the speech plausibly matches it. Do not invent content, change clear speech, or include existing composer text in the result. Return only the cleaned transcript.
<composer_before>
${draft.text.slice(0, cursor)}
</composer_before>${selectionBlock}
<composer_after>
${draft.text.slice(selectionEnd)}
</composer_after>`;
}

/** Builds the prompt for a spoken instruction that rewrites the selection or writes text at the cursor. */
export function buildVoiceCommandPrompt(
  instruction: string,
  draft: Draft,
  targetApp?: string,
): string {
  const cursor = Math.max(0, Math.min(draft.selection.start, draft.text.length));
  const selectionEnd = Math.max(cursor, Math.min(draft.selection.end, draft.text.length));
  const rewrites = selectionEnd > cursor;
  const task = rewrites
    ? "Rewrite composer_selection the way the instruction asks. Return only the replacement for the selection."
    : "Write the text the instruction asks for. It is inserted at the cursor between composer_before and composer_after. Return only the new text.";
  const selectionBlock = rewrites
    ? `\n<composer_selection>\n${draft.text.slice(cursor, selectionEnd)}\n</composer_selection>`
    : "";
  return `The person spoke an instruction for editing text. The instruction is a speech transcript and may contain recognition errors.${targetAppLine(targetApp)}

<instruction>
${instruction}
</instruction>

${task} Keep the language and tone of the surrounding text unless the instruction asks for something else. Do not explain, quote, or wrap the result in Markdown fences.
<composer_before>
${draft.text.slice(0, cursor)}
</composer_before>${selectionBlock}
<composer_after>
${draft.text.slice(selectionEnd)}
</composer_after>`;
}
