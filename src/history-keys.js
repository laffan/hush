/**
 * ⌘Z / ⇧⌘Z as the iPad hands them over.
 *
 * iPadOS's menu bar claims ⌘Z for its Edit menu, so the page gets no
 * keydown for it: the press becomes UIKit's `undo:`, which WebKit passes
 * on only to an editable element with history in its own undo stack (as
 * a `historyUndo` beforeinput — how a Doc still undid). A notebook canvas
 * keeps its own history and isn't editable, so ⌘Z there reached nothing.
 *
 * tauri-plugin-pencil's HistoryKeys.swift takes the two presses ahead of
 * the menu and calls `window.__hushHistoryKey("undo" | "redo")`. This
 * dispatches the keydown the press would have produced, at the focused
 * element, so whatever handles ⌘Z on the Mac handles it here — the
 * canvas's window listener, CodeMirror's history keymap, the Shuffle
 * editor. A plain text field that nothing claims (a notebook text shape's
 * textarea, an input) gets its native undo instead.
 *
 * Every press is written to the activity log (Settings → Debug, source
 * "undo"), with where the focus was and what took it, since the iPad has
 * no other way to show why one did nothing.
 */
import { logActivity } from "./activity-log.js";
import { describeActiveElement } from "./paste-diagnostics.js";

function isTextField(el) {
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

/** The ⌘Z keydown a hardware press makes. `keyCode` is set by hand as
 *  well: CodeMirror reads it to match ⇧⌘Z (key "Z") against Mod-Shift-z,
 *  and not every engine takes it from the event's init dictionary. */
function historyKeyEvent(redo) {
  const ev = new KeyboardEvent("keydown", {
    key: redo ? "Z" : "z", code: "KeyZ", keyCode: 90, which: 90,
    metaKey: true, shiftKey: redo, bubbles: true, cancelable: true,
  });
  if (ev.keyCode !== 90) {
    try {
      Object.defineProperty(ev, "keyCode", { get: () => 90 });
      Object.defineProperty(ev, "which", { get: () => 90 });
    } catch (_) { /* read-only here; CodeMirror's undo still matches */ }
  }
  return ev;
}

/** What the canvas side knew at the moment of the press, for the log. */
async function canvasDetail() {
  try {
    const { getActiveNotebookState } = await import("./notebook/notes-canvas.ts");
    const st = getActiveNotebookState();
    if (!st) return { canvas: "none" };
    return {
      canvas: st.canvasEl?.getClientRects().length ? "on screen" : "hidden",
      canUndo: st.canUndo, canRedo: st.canRedo, editingText: !!st.editingText,
    };
  } catch (_) {
    return { canvas: "not loaded" };
  }
}

export function installHistoryKeys() {
  window.__hushHistoryKey = (direction) => {
    const redo = direction === "redo";
    const focus = describeActiveElement();
    const active = document.activeElement;
    const target = active && active !== document.documentElement ? active : document.body;
    const ev = historyKeyEvent(redo);
    target.dispatchEvent(ev);
    let by = ev.defaultPrevented ? "page" : "";
    if (!by && isTextField(target)) {
      try { if (document.execCommand(redo ? "redo" : "undo")) by = "native text field"; } catch (_) { /* no history */ }
    }
    const label = redo ? "Redo" : "Undo";
    void canvasDetail().then((canvas) => {
      logActivity("undo", by ? "info" : "warn",
        by ? `${label} (⌘Z from iPadOS) handled by ${by}` : `${label} (⌘Z from iPadOS) reached nothing`,
        { focus, mode: document.body.className.match(/\b\w+-mode\b/g)?.join(" ") || "doc", ...canvas });
    });
  };
}
