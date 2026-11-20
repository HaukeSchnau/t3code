import { describe, expect, it } from "vite-plus/test";

import {
  isTriageEscape,
  triageEscapeCloses,
  triageKeyAction,
  triageKeyTarget,
  triageReplySends,
} from "./triageKeys";

function key(value: string, options: Partial<Parameters<typeof triageKeyAction>[0]> = {}) {
  return {
    key: value,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    ...options,
  };
}

function mount(html: string) {
  const host = document.createElement("div");
  host.setAttribute("data-app-modal", "");
  host.setAttribute("role", "dialog");
  host.innerHTML = html;
  document.body.append(host);
  return { host, [Symbol.dispose]: () => host.remove() };
}

describe("triage keys", () => {
  it("act on the deck and nowhere a key belongs to something else", () => {
    using view = mount(
      `<button id="deck">Send</button><textarea id="reply"></textarea>` +
        `<div contenteditable="true"><span id="editor">x</span></div>` +
        `<div role="menu"><button id="menu">Snooze</button></div>` +
        `<div role="dialog"><button id="fullscreen">Close</button></div>`,
    );
    const at = (id: string) => triageKeyTarget(view.host.querySelector(`#${id}`));
    expect(at("deck")).toBe("deck");
    expect(triageKeyTarget(view.host)).toBe("deck");
    expect(at("reply")).toBe("typing");
    expect(at("editor")).toBe("typing");
    expect(at("menu")).toBe("layer");
    expect(at("fullscreen")).toBe("layer");

    expect(triageKeyAction(key("j"), "deck")).toBe("next");
    expect(triageKeyAction(key("K"), "deck")).toBe("previous");
    expect(triageKeyAction(key("x"), "typing")).toBeNull();
    expect(triageKeyAction(key("s"), "layer")).toBeNull();
    // Esc closes triage from the deck only, not from the reply box.
    expect(triageEscapeCloses(key("Escape"), "deck")).toBe(true);
    expect(triageEscapeCloses(key("Escape"), "typing")).toBe(false);
  });

  it("leave chords, IME input and held action keys alone", () => {
    expect(triageKeyAction(key("k", { metaKey: true }), "deck")).toBeNull();
    expect(triageKeyAction(key("s", { shiftKey: true }), "deck")).toBeNull();
    expect(triageKeyAction(key("o", { isComposing: true }), "deck")).toBeNull();
    expect(triageKeyAction(key("o", { keyCode: 229 }), "deck")).toBeNull();
    expect(triageEscapeCloses(key("Escape", { shiftKey: true }), "deck")).toBe(false);
    expect(triageEscapeCloses(key("Escape", { metaKey: true }), "deck")).toBe(false);
    // One Esc guard for leaving the reply box and closing triage: Shift+Esc leaves the box
    // alone, and a held Esc that left the box does not go on to close triage.
    expect(isTriageEscape(key("Escape"))).toBe(true);
    expect(isTriageEscape(key("Escape", { shiftKey: true }))).toBe(false);
    expect(isTriageEscape(key("Escape", { keyCode: 229 }))).toBe(false);
    expect(triageEscapeCloses(key("Escape", { repeat: true }), "deck")).toBe(false);
    expect(triageKeyAction(key("x", { defaultPrevented: true }), "deck")).toBeNull();
    expect(triageKeyAction(key("s", { repeat: true }), "deck")).toBeNull();
    expect(triageKeyAction(key("j", { repeat: true }), "deck")).toBe("next");
    // Only plain Enter sends the reply.
    expect(triageReplySends(key("Enter"))).toBe(true);
    expect(triageReplySends(key("Enter", { shiftKey: true }))).toBe(false);
    expect(triageReplySends(key("Enter", { ctrlKey: true }))).toBe(false);
    expect(triageReplySends(key("Enter", { metaKey: true }))).toBe(false);
    // The Enter that commits an IME composition.
    expect(triageReplySends(key("Enter", { isComposing: true }))).toBe(false);
    expect(triageReplySends(key("Enter", { keyCode: 229 }))).toBe(false);
  });
});
