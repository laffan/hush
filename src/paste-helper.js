/**
 * Touch-mode Paste — read the OS clipboard and route the contents into
 * whatever editing surface is currently in focus. Mirrors what Cmd+V
 * would do when the user has a hardware keyboard, except it works on
 * iPadOS too where the virtual-keyboard route doesn't reach
 * CodeMirror's native paste path.
 *
 * Order of preference:
 *   1. Focused INPUT / TEXTAREA → setRangeText + dispatch input event
 *      so any change listeners (e.g. CodeMirror's auto-save, the
 *      notebook's inline text editor) fire.
 *   2. Focused contenteditable (CodeMirror, etc.) → execCommand
 *      "insertText". CodeMirror handles the resulting beforeinput
 *      event as a regular insert transaction.
 *   3. No editable focus → synthesize a Cmd+V keydown on `window`.
 *      The notebook's input handler picks it up when a notebook
 *      canvas is the active hush surface; the keydown's preventDefault
 *      tells us it consumed the event.
 *   4. Otherwise → focus the doc editor's `.cm-content` and execCommand
 *      insertText so the doc receives the text.
 */

import { readText as tauriReadText } from "@tauri-apps/plugin-clipboard-manager";

const IS_TAURI =
  typeof window !== "undefined" &&
  window.__TAURI_INTERNALS__ != null;

async function readClipboardText() {
  if (IS_TAURI) {
    try { return await tauriReadText(); } catch (_) { /* fall through */ }
  }
  try { return await navigator.clipboard.readText(); } catch (_) { return ""; }
}

export async function pasteAtFocus() {
  const text = await readClipboardText();
  if (!text) return;

  const target = document.activeElement;

  // Focused INPUT / TEXTAREA
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    if (typeof target.setRangeText === "function") {
      target.setRangeText(text, start, end, "end");
    } else {
      target.value = target.value.slice(0, start) + text + target.value.slice(end);
      target.selectionStart = target.selectionEnd = start + text.length;
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  // Focused contenteditable (CodeMirror's `.cm-content` lands here)
  if (target && target.isContentEditable) {
    insertViaExecCommand(text);
    return;
  }

  // Nothing editable focused — let the notebook handler claim it via
  // a synthetic Cmd+V keydown. The handler calls preventDefault when
  // it consumes the event, which makes dispatchEvent return false.
  const ke = new KeyboardEvent("keydown", {
    key: "v", code: "KeyV",
    metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
    bubbles: true, cancelable: true,
  });
  const notConsumed = window.dispatchEvent(ke);
  if (!notConsumed) return;

  // Doc fallback: focus the editor's contenteditable and insert.
  const cm = document.querySelector(".cm-content");
  if (cm) {
    cm.focus();
    insertViaExecCommand(text);
  }
}

function insertViaExecCommand(text) {
  // execCommand is deprecated but WebKit (and Chromium) still honour
  // "insertText" for contenteditable hosts, and CodeMirror's beforeinput
  // listener turns the resulting input event into a regular transaction.
  // No good replacement exists for the cross-editor case yet.
  try { document.execCommand("insertText", false, text); } catch (_) { /* ignore */ }
}
