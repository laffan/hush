/**
 * An outline on a canvas, drawn the way a Doc draws one.
 *
 * A notebook outline used to be painted on the canvas and edited as raw
 * markdown in the inline textarea, so none of what makes an outline in a
 * Doc worth using was there: no typing into the rendered list, no grip
 * to drag an item, no Option-↑/↓ or ⌘[ / ⌘], no − / + for the type.
 * This is the component the canvas's outline layer
 * (notebook/ui/outline-layer.ts) lays over each outline instead — handed
 * over through `window.__hushOutlines`, as cards are, because the
 * notebook bundle doesn't import app modules.
 *
 * It is the pinned outline's panel again (editor/outline-pinned-editor.js):
 * a CodeMirror editor built by `createPaneEditor` from the shared
 * extension list, whose whole document is the outline — the
 * `outlineHost` facet says so, since there is no frontmatter to, and
 * lends it the shape's hide-completed switch — under the Doc's own footer
 * (`buildOutlineFooter`). The checkboxes, the drag grip, the keymaps,
 * hide-completed and undo are the Doc's code running on the same lines;
 * `keepChecklist` holds the pinned panel's rule that every line stays an
 * item, since a line that stopped being one would have nowhere to show.
 *
 * The element knows nothing of the canvas. Edits go out through
 * `onEdit` (never for a `setText`), the footer's switches through
 * `onToggleHideDone` / `onTogglePin`, and the layer pushes changes back
 * in with `setText` / `setFlags`.
 */

import { EditorView, keymap } from "@codemirror/view";
import { Compartment, Prec } from "@codemirror/state";
import { createPaneEditor } from "../pane/pane-editor.js";
import { programmaticChange } from "../editor/base-extensions.js";
import { outlineHost, stepOutlineFont } from "../editor/plugins/outline-view.js";
import { keepChecklist } from "../editor/outline-pinned-editor.js";
import { buildOutlineFooter } from "../editor/outline-dom.js";

/** Shortest a pinned outline may be dragged to: its grip, a row, and
 *  its footer — the Doc's pinned panel's floor. */
const MIN_PIN_HEIGHT = 84;

/**
 * @param {object} o
 * @param {object} o.appState
 * @param {string} o.text
 * @param {boolean} o.hideDone
 * @param {boolean} o.pinned
 * @param {(text: string) => void} o.onEdit
 * @param {() => void} o.onToggleHideDone
 * @param {() => void} o.onTogglePin
 * @param {() => void} [o.onEscape]
 * @param {() => number} [o.getHostHeight]  Height of the frame a pinned
 *   outline docks to, which bounds its drag.
 */
export function createOutlineCanvasElement(o) {
  const el = document.createElement("div");
  el.className = "nb-outline";
  const grip = document.createElement("div");
  grip.className = "outline-pin-grip";
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "horizontal");
  const body = document.createElement("div");
  body.className = "nb-outline-editor";
  el.append(grip, body);

  let text = o.text || "";
  let flags = { hideDone: !!o.hideDone, pinned: !!o.pinned };
  let destroyed = false;

  const hostComp = new Compartment();
  const listener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    text = update.state.doc.toString();
    if (update.transactions.some((tr) => tr.annotation(programmaticChange))) return;
    o.onEdit(text);
  });
  const escape = Prec.highest(keymap.of([
    { key: "Escape", run: () => { o.onEscape?.(); return !!o.onEscape; } },
  ]));
  // No typewriter: an outline has no page to hold a line in the middle of.
  const modeContext = Object.create(o.appState);
  modeContext.typewriterMode = false;
  const editor = createPaneEditor(body, o.appState, null, {
    modeContext,
    fragment: true,
    lineIndicator: false,
    leadingExtensions: [escape],
    extraExtensions: [hostComp.of(outlineHost.of({ hideDone: flags.hideDone })), keepChecklist, listener],
  });
  editor.reconfigureTheme(o.appState.settings, null);
  editor.setContent(text);
  const onTheme = () => { if (!destroyed) editor.reconfigureTheme(o.appState.settings, null); };
  o.appState.on?.("theme-changed", onTheme);
  o.appState.on?.("style-changed", onTheme);
  o.appState.on?.("style-preview-end", onTheme);

  let footer = null;
  function paintFlags() {
    el.classList.toggle("pinned", flags.pinned);
    footer?.remove();
    footer = buildOutlineFooter({
      hideDone: flags.hideDone,
      pinned: flags.pinned,
      onToggleHideDone: () => o.onToggleHideDone(),
      onTogglePin: () => o.onTogglePin(),
      onFontStep: (d) => stepOutlineFont(o.appState, [editor.view], d),
    });
    el.appendChild(footer);
    applyPinnedHeight();
  }

  // ── A pinned outline's height, from its top edge ────────────────
  // The Doc's pinned panel's grip, and the same per-device setting: how
  // much of the frame a pinned outline takes describes this screen.
  function storedHeight() {
    const n = Number(o.appState?.settings?.outlinePinnedHeight);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function applyPinnedHeight() {
    const h = flags.pinned ? storedHeight() : null;
    el.style.height = h ? `${h}px` : "";
    el.style.maxHeight = h ? "none" : "";
  }
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !flags.pinned) return;
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = el.getBoundingClientRect().height;
    const hostH = o.getHostHeight?.() || window.innerHeight;
    let applied = startH;
    grip.classList.add("dragging");
    el.style.maxHeight = "none";
    try { grip.setPointerCapture(e.pointerId); } catch (_) { /* detached */ }
    const move = (me) => {
      const max = Math.max(MIN_PIN_HEIGHT, hostH - 48);
      applied = Math.max(MIN_PIN_HEIGHT, Math.min(max, startH - (me.clientY - startY)));
      el.style.height = `${Math.round(applied)}px`;
    };
    const up = () => {
      grip.classList.remove("dragging");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      o.appState?.updateSettings?.({ outlinePinnedHeight: Math.round(applied) });
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });

  paintFlags();

  return {
    el,
    get view() { return editor.view; },
    getText: () => text,
    /** Take `next` as the outline — a programmatic diff, so the caret and
     *  the editor's own undo history survive. */
    setText(next) {
      if (destroyed || next === text) return;
      text = next;
      editor.setContent(next);
    },
    setFlags(next) {
      if (destroyed) return;
      const f = { hideDone: !!next.hideDone, pinned: !!next.pinned };
      if (f.hideDone === flags.hideDone && f.pinned === flags.pinned) return;
      const hideChanged = f.hideDone !== flags.hideDone;
      flags = f;
      if (hideChanged) {
        editor.view.dispatch({ effects: hostComp.reconfigure(outlineHost.of({ hideDone: f.hideDone })) });
      }
      paintFlags();
    },
    hasFocus: () => editor.view.hasFocus,
    /** Put the caret at a screen point (a double-click's), or at the end. */
    focusAt(x, y) {
      if (destroyed) return;
      const view = editor.view;
      const pos = x != null && y != null ? view.posAtCoords({ x, y }) : null;
      view.dispatch({ selection: { anchor: pos ?? view.state.doc.length } });
      editor.focus();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      o.appState.off?.("theme-changed", onTheme);
      o.appState.off?.("style-changed", onTheme);
      o.appState.off?.("style-preview-end", onTheme);
      editor.destroy();
      el.remove();
    },
  };
}

/** Boot wiring, from main.js: the canvas reaches the element through a
 *  window bridge, as it reaches cards (cards/cards-init.js). */
export function initOutlineCanvas() {
  window.__hushOutlines = { createOutlineElement: createOutlineCanvasElement };
}
