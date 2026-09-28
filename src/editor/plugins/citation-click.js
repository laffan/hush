/**
 * ⌘-click on a citation: open the Zotero link menu ("Open in Zotero" /
 * "Open in Hush" / "Download to Hush") and leave the pill rendered.
 *
 * A plain click inside a citation reveals its raw markdown so the
 * citekey and deep link can be edited; a ⌘-click is a request for the
 * menu, not an edit, so it must not reveal anything. Two things keep it
 * from doing so:
 *
 *   1. The rendered pill opens the menu from its own `pointerdown`, the
 *      gesture's first event — before a tap places the caret (iPadOS
 *      puts it there natively, ahead of the trailing compatibility
 *      `mousedown`) and before CodeMirror's own handling. Same route as
 *      LinkWidget, for the same reason.
 *   2. For a moment after the menu opens, a pointer-driven selection
 *      that lands inside that citation is dropped (`holdReveal`), so a
 *      caret the platform places anyway can't expand it.
 */
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { isIOS } from "../../settings/settings-ui.js";

/** How long a ⌘-click keeps the pill it opened from rendered. Covers
 *  iPadOS's compatibility mouse events, which trail a tap by a few
 *  hundred ms. */
const HOLD_MS = 900;

/** On iOS, modifier state from a paired keyboard doesn't always reach
 *  touch-synthesized events — mirror link-decorator's tracker. */
let _modifierHeld = false;
if (isIOS()) {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Meta" || e.key === "Control") _modifierHeld = true;
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "Meta" || e.key === "Control") _modifierHeld = false;
  });
  window.addEventListener("blur", () => { _modifierHeld = false; });
}

function hasModifier(e) {
  // Honour the touch-mode ⌘ pill too (its synthetic Meta keydown is
  // dispatched on `window`, so the document-level `_modifierHeld` tracker
  // never sees it) — mirrors link-decorator + the notebook canvas.
  return e.metaKey || e.ctrlKey || _modifierHeld ||
    (typeof window !== "undefined" && !!window.__hushCmdHeld);
}

/** `{ doc, from, to, until }` — the citation a ⌘-click just opened, in
 *  the document it was opened from. */
let hold = null;

function holdReveal(view, from, to) {
  hold = { doc: view.state.doc, from, to, until: Date.now() + HOLD_MS };
}

/** Drops a pointer selection that would land inside the held citation. */
const revealHoldFilter = EditorState.transactionFilter.of((tr) => {
  if (!hold || tr.docChanged || !tr.selection) return tr;
  if (Date.now() > hold.until || tr.startState.doc !== hold.doc) { hold = null; return tr; }
  if (!tr.isUserEvent("select")) return tr;
  const inside = tr.selection.ranges.some((r) => r.from >= hold.from && r.to <= hold.to);
  return inside ? [] : tr;
});

// A pill's `pointerdown` and CodeMirror's `mousedown` can both see one
// press — ~0 ms apart on desktop, a few hundred ms on iPad.
let lastOpen = { key: null, t: 0 };

async function openUrl(url) {
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    try {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(url);
      return;
    } catch (_) { /* fall through */ }
  }
  window.open(url, "_blank");
}

/**
 * Open the Zotero tooltip menu for a citation instead of jumping
 * straight to the Zotero app — the same menu `[Title](zotero://…)` links
 * use. A bare `@citekey` with no deep link is resolved to its item's
 * select URL first. The anchor rect is captured by the caller
 * (synchronously, since the citation widget can be torn down while the
 * menu module imports).
 */
async function openCitationMenu(url, citekey, anchor) {
  const key = url || citekey;
  const now = Date.now();
  if (key === lastOpen.key && now - lastOpen.t < 600) return;
  lastOpen = { key, t: now };
  let target = url || null;
  if (!target && citekey) {
    try {
      const { loadReferences } = await import("../../zotero.js");
      const ref = ((await loadReferences()) || []).find((r) => r.citekey === citekey);
      if (ref) target = `zotero://select/library/items/${ref.key}`;
    } catch { /* Zotero not configured */ }
  }
  if (!target) return;
  try {
    const { openZoteroLinkMenu } = await import("../../links/zotero-link-menu.js");
    openZoteroLinkMenu(target, anchor);
  } catch {
    void openUrl(target); // fallback: open Zotero directly
  }
}

/** Wire a rendered citation pill's own ⌘-press (see the header, 1). */
export function attachCitationOpen(span) {
  span.addEventListener("pointerdown", (e) => {
    if (!hasModifier(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const view = EditorView.findFromDOM(span);
    if (view) {
      const from = view.posAtDOM(span);
      holdReveal(view, from, from + span.dataset.length * 1);
    }
    const r = span.getBoundingClientRect();
    void openCitationMenu(span.dataset.citeUrl || null, span.dataset.citekey || null,
      { left: r.left, top: r.top, bottom: r.bottom });
  });
}

/** The editor-level half: a press on the pill that reached CodeMirror
 *  (it must not also move the caret), and raw `[@…]` markdown showing
 *  because the caret is already inside it. */
export function createCitationClickHandler(citationAtPos) {
  const handlers = EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!hasModifier(e)) return false;
      const widget = e.target.closest?.(".cm-citation-rendered");
      if (widget) {
        e.preventDefault();
        const from = view.posAtDOM(widget);
        holdReveal(view, from, from + widget.dataset.length * 1);
        const r = widget.getBoundingClientRect();
        void openCitationMenu(widget.dataset.citeUrl || null, widget.dataset.citekey || null,
          { left: r.left, top: r.top, bottom: r.bottom });
        return true;
      }
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const item = citationAtPos(view.state.doc, pos);
      if (item) {
        e.preventDefault();
        void openCitationMenu(item.url || null, item.citekey || null,
          { x: e.clientX, y: e.clientY });
        return true;
      }
      return false;
    },
  });
  return [handlers, revealHoldFilter];
}
