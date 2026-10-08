/**
 * The card as it appears on every surface — one DOM component, so a card
 * in a Doc, on a canvas and in Courier looks and behaves the same.
 *
 *   ┌──────────────────────────────────────┐
 *   │ ⠿ title                 ●  ⊥  ⤓  ×  │  header: drag handle + buttons
 *   ├──────────────────────────────────────┤
 *   │ the card's markdown, in a real       │  body: a CodeMirror editor,
 *   │ CodeMirror editor                    ┃  as tall as its text and one
 *   │                                      ┃  line more; the right edge
 *   └──────────────────────────────────────┘  resizes the width
 *
 * The body is an editor built by the pane editor factory from the same
 * extension list every doc surface uses — that is what makes "cards
 * support the same markdown Docs do" true rather than approximated — set
 * in the app's UI face instead of the style's (styles/cards.css). Three
 * things are added to it:
 *
 *   - the 100-word wall (`createFixedWordLimit`, the per-document cap's
 *     filter at a fixed number): at the cap nothing more lands, and a
 *     card that arrived longer keeps its words and turns red;
 *   - a fence guard: a line that is exactly `<<<` or `>>>` would end the
 *     card in the text around it, so the editor refuses one, and the
 *     same for a last line that would read as the card's metadata
 *     (`%%card …%%`);
 *   - `insideCard`, which keeps the card plugin itself off in here.
 *
 * The element knows nothing about where it lives. Each surface hands it
 * callbacks — an edit to replay, an action, a header press to turn into
 * a drag, a resize — and pushes changes back in with `setBody` /
 * `setMeta`. The pane editor factory is handed over from main.js
 * (`setCardEditorFactory`), because importing it here would close an
 * import cycle through the shared extension list — the pinned outline's
 * editor is wired the same way.
 */

import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { programmaticChange } from "../editor/base-extensions.js";
import { createFixedWordLimit } from "../editor/word-limit.js";
import { openBookmarkColorPalette } from "../ui/bookmark-ui.js";
import { insideCard } from "./card-facet.js";
import { rememberedInsertPoint } from "./card-cursor.js";
import {
  CARD_MAX_WORDS, CARD_MIN_WIDTH,
  cardSize, cardTitle, cardWordCount, isFenceLine, parseMetaLine,
} from "./card-model.ts";

let editorFactory = null;

/** main.js hands over `createPaneEditor` before the first card exists. */
export function setCardEditorFactory(fn) { editorFactory = fn; }

const ICONS = {
  grip: `<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="4" cy="3" r="1"/><circle cx="8" cy="3" r="1"/><circle cx="4" cy="6" r="1"/><circle cx="8" cy="6" r="1"/><circle cx="4" cy="9" r="1"/><circle cx="8" cy="9" r="1"/></svg>`,
  insert: `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5v8.5M3 7l3 3 3-3"/></svg>`,
  delete: `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5"/></svg>`,
  mark: `<svg viewBox="0 0 12 14" aria-hidden="true"><path d="M6 1v10M2.5 7.5L6 11l3.5-3.5"/></svg>`,
  pin: `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.3 1.5h3.4M4.8 1.5v3L3.2 6.6h5.6L7.2 4.5v-3M6 6.6v3.9"/></svg>`,
};

/** Refuse an edit that would leave a fence line in the card, or end the
 *  card on something that reads as its metadata. */
const fenceGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(programmaticChange)) return tr;
  const doc = tr.newDoc;
  let ok = true;
  tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
    if (!ok) return;
    const last = doc.lineAt(toB).number;
    for (let n = doc.lineAt(fromB).number; n <= last && ok; n++) {
      if (isFenceLine(doc.line(n).text)) ok = false;
    }
  });
  if (ok && parseMetaLine(doc.line(doc.lines).text)) ok = false;
  return ok ? tr : [];
});

/** Past the limit a card is red and takes nothing more — not even the
 *  letters that would finish a word, which the document cap lets through
 *  at its line. Rewriting (anything that also removes) still lands. */
const overLimitGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(programmaticChange)) return tr;
  let inserts = false;
  let deletes = false;
  tr.changes.iterChanges((fromA, toA, _fb, _tb, text) => {
    if (text.length) inserts = true;
    if (toA > fromA) deletes = true;
  });
  if (!inserts || deletes) return tr;
  return cardWordCount(tr.startState.doc.toString()) > CARD_MAX_WORDS ? [] : tr;
});

/**
 * @param {object} o
 * @param {object} o.appState
 * @param {string} o.body
 * @param {object} o.meta
 * @param {"doc"|"nb"|"courier"} o.surface
 * @param {(update: import("@codemirror/view").ViewUpdate) => void} [o.onEdit]
 *   A user edit in the body (never a `setBody`).
 * @param {(action: string, e?: Event, arg?: unknown) => void} [o.onAction]
 *   "color" (arg: the colour, or null to clear) | "collapse" (a double-
 *   click on the header) | "pin" (Docs only) | "insert" | "delete"
 * @param {(e: PointerEvent) => void} [o.onHeaderDown]  A press on the header
 *   outside its buttons — the start of a drag.
 * @param {(width: number) => void} [o.onResize]  End of a resize from the
 *   right edge. A card's height is its text's (and one line more).
 * @param {() => number} [o.getScale]  CSS scale the card is drawn at (a
 *   canvas's zoom), so the edge tracks the pointer.
 * @param {() => void} [o.onEscape]
 * @param {() => void} [o.onSubmit]  ⌘↩ in the body (Courier's send).
 * @param {() => ({ view: import("@codemirror/view").EditorView, pos: number } | null)} [o.insertPoint]
 *   Where insert-at-cursor would put the words, marked while the pointer
 *   is on the button. Defaults to the remembered document caret
 *   (card-cursor.js), where a canvas card's words go.
 * @param {boolean} [o.hideInsert]  No insert-at-cursor button (Courier).
 * @param {boolean} [o.hideDelete]
 */
export function createCardElement(o) {
  const el = document.createElement("div");
  el.className = `hush-card hush-card-${o.surface}`;
  el.innerHTML = `
    <div class="hush-card-header">
      <span class="hush-card-grip">${ICONS.grip}</span>
      <span class="hush-card-title"></span>
      <button type="button" class="hush-card-btn hush-card-color" data-act="color" data-tooltip="Background colour" aria-label="Background colour"><span class="hush-card-swatch"></span></button>
      ${o.surface === "doc" ? `<button type="button" class="hush-card-btn hush-card-pin" data-act="pin" data-tooltip="Pin in view" aria-label="Pin in view">${ICONS.pin}</button>` : ""}
      ${o.hideInsert ? "" : `<button type="button" class="hush-card-btn" data-act="insert" data-tooltip="Insert at cursor" aria-label="Insert at cursor">${ICONS.insert}</button>`}
      ${o.hideDelete ? "" : `<button type="button" class="hush-card-btn" data-act="delete" data-tooltip="Delete card" aria-label="Delete card">${ICONS.delete}</button>`}
    </div>
    <div class="hush-card-body"></div>
    <div class="hush-card-resize" aria-hidden="true"></div>`;
  const header = el.querySelector(".hush-card-header");
  const titleEl = el.querySelector(".hush-card-title");
  const bodyEl = el.querySelector(".hush-card-body");
  const grip = el.querySelector(".hush-card-resize");
  const pinBtn = el.querySelector(".hush-card-pin");
  const insertBtn = el.querySelector('[data-act="insert"]');

  let meta = { ...(o.meta || {}) };
  let body = o.body || "";
  let destroyed = false;

  function paintCount(text) {
    const n = cardWordCount(text);
    el.classList.toggle("over-limit", n > CARD_MAX_WORDS);
    el.classList.toggle("at-limit", n >= CARD_MAX_WORDS);
    titleEl.textContent = cardTitle(text);
  }

  function paintMeta() {
    el.style.width = `${cardSize(meta).width}px`;
    el.classList.toggle("collapsed", !!meta.collapsed);
    if (meta.bgColor) el.style.setProperty("--card-accent", meta.bgColor);
    else el.style.removeProperty("--card-accent");
    el.classList.toggle("has-color", !!meta.bgColor);
    el.classList.toggle("pinned", !!meta.pinned);
    if (pinBtn) {
      const label = meta.pinned ? "Unpin" : "Pin in view";
      pinBtn.dataset.tooltip = label;
      pinBtn.setAttribute("aria-label", label);
    }
  }

  // ── The body's editor ────────────────────────────────────────────
  const listener = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    body = update.state.doc.toString();
    paintCount(body);
    if (update.transactions.some((tr) => tr.annotation(programmaticChange))) return;
    o.onEdit?.(update);
  });
  const escape = Prec.highest(keymap.of([
    { key: "Escape", run: () => { o.onEscape?.(); return !!o.onEscape; } },
    { key: "Mod-Enter", run: () => { o.onSubmit?.(); return !!o.onSubmit; } },
  ]));
  // No typewriter in a card — it is a few lines tall and has no page to
  // hold a line in the middle of. No sentence mask either: under focus
  // mode a card fades as a whole, and comes back whole while it is
  // being typed in (styles/focus-mode.css).
  const modeContext = Object.create(o.appState);
  modeContext.typewriterMode = false;
  modeContext.focusMode = false;
  let editor = null;
  if (editorFactory) {
    editor = editorFactory(bodyEl, o.appState, null, {
      modeContext,
      fragment: true,
      lineIndicator: false,
      leadingExtensions: [escape],
      extraExtensions: [insideCard.of(true), fenceGuard, overLimitGuard, createFixedWordLimit(CARD_MAX_WORDS), listener],
    });
    editor.reconfigureTheme(o.appState.settings, null);
    editor.setContent(body);
  } else {
    bodyEl.textContent = body;
  }
  const onTheme = () => { if (!destroyed) editor?.reconfigureTheme(o.appState.settings, null); };
  o.appState.on?.("theme-changed", onTheme);
  o.appState.on?.("style-changed", onTheme);

  paintCount(body);
  paintMeta();

  // ── Header: buttons, and the press that starts a drag ────────────
  // Buttons act on pointerdown (README-TECHNICAL: the one event certain
  // to arrive while the control is still there on iOS) and keep the
  // focus where it was, so insert-at-cursor still knows where the caret
  // is.
  header.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const btn = e.target instanceof Element ? e.target.closest("[data-act]") : null;
    e.stopPropagation();
    e.preventDefault();
    if (btn) {
      const act = btn.dataset.act;
      if (act === "color") {
        openBookmarkColorPalette({
          anchor: btn,
          color: meta.bgColor,
          onPick: (c) => o.onAction?.("color", e, c),
          actions: meta.bgColor ? [{ label: "No colour", run: () => o.onAction?.("color", e, null) }] : [],
        });
        // The palette mounts on <body> in the popover band; a card in a
        // sheet above that band (Courier, at --z-courier) needs it over
        // the sheet, not behind it.
        const sheet = el.closest(".courier-root");
        const pop = document.querySelector(".bm-palette");
        if (sheet && pop) pop.style.zIndex = "calc(var(--z-courier) + 2)";
        return;
      }
      if (act === "insert") markInsertPoint(false);
      o.onAction?.(act, e);
      return;
    }
    o.onHeaderDown?.(e);
  });
  // A mouse press on the header must not reach an editor underneath and
  // move its caret, or insert-at-cursor would insert at the header.
  header.addEventListener("mousedown", (e) => e.preventDefault());
  header.addEventListener("dblclick", (e) => {
    if (e.target instanceof Element && e.target.closest("[data-act]")) return;
    e.preventDefault();
    e.stopPropagation();
    o.onAction?.("collapse", e);
  });

  // ── Where insert-at-cursor will put the words ──────────────────
  // A red arrow over the spot, while the pointer is on the button.
  let mark = null;
  function markInsertPoint(on) {
    mark?.remove();
    mark = null;
    if (!on || destroyed) return;
    const at = (o.insertPoint || rememberedInsertPoint)();
    const c = at ? at.view.coordsAtPos(at.pos) : null;
    if (!c) return;
    mark = createInsertMark();
    placeInsertMark(mark, c);
  }
  insertBtn?.addEventListener("pointerenter", () => markInsertPoint(true));
  insertBtn?.addEventListener("pointerleave", () => markInsertPoint(false));

  // ── Width, from the right edge ─────────────────────────────────
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || meta.collapsed) return;
    e.stopPropagation();
    e.preventDefault();
    const scale = o.getScale?.() || 1;
    const startX = e.clientX;
    const startW = el.getBoundingClientRect().width / scale;
    let w = Math.round(startW);
    el.classList.add("resizing");
    try { grip.setPointerCapture(e.pointerId); } catch (_) { /* detached */ }
    const move = (me) => {
      w = Math.max(CARD_MIN_WIDTH, Math.round(startW + (me.clientX - startX) / scale));
      // Important: a Doc card's width is otherwise its margin's call
      // (styles/cards.css, `.cm-card-float`).
      el.style.setProperty("width", `${w}px`, "important");
    };
    const up = () => {
      el.classList.remove("resizing");
      el.style.width = `${w}px`;
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      if (Math.abs(w - startW) >= 1) o.onResize?.(w);
      else paintMeta();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  });

  return {
    el,
    get view() { return editor?.view || null; },
    getBody: () => body,
    getMeta: () => ({ ...meta }),
    /** Take `text` as the body — a programmatic diff, so the caret and
     *  the card's own undo history survive. */
    setBody(text) {
      if (destroyed || text === body) return;
      body = text;
      if (editor) editor.setContent(text);
      else bodyEl.textContent = text;
      paintCount(text);
    },
    setMeta(next) {
      if (destroyed) return;
      meta = { ...(next || {}) };
      paintMeta();
    },
    setSelected(on) { el.classList.toggle("selected", !!on); },
    hasFocus: () => !!editor?.view.hasFocus,
    focus(atEnd = true) {
      if (!editor) return;
      if (atEnd) editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
      editor.focus();
    },
    destroy() {
      if (destroyed) return;
      markInsertPoint(false);
      destroyed = true;
      o.appState.off?.("theme-changed", onTheme);
      o.appState.off?.("style-changed", onTheme);
      editor?.destroy();
      el.remove();
    },
  };
}

/** The red arrow that marks where a card's words will go — over the
 *  insert-at-cursor point while the pointer is on that button, and over
 *  the drop point while a card is carried with ⌘ held
 *  (card-drag-feedback.js). Mounted on <body>. */
export function createInsertMark() {
  const mark = document.createElement("div");
  mark.className = "hush-card-insert-mark";
  mark.innerHTML = ICONS.mark;
  document.body.appendChild(mark);
  return mark;
}

/** Point the arrow at `coords` (a `coordsAtPos` rect). */
export function placeInsertMark(mark, coords) {
  mark.style.transform = `translate(${Math.round(coords.left)}px, ${Math.round(coords.top)}px)`;
}

/** A static copy of a card element for a drag ghost: same size and
 *  colour, the body as plain text. */
export function cardGhost(body, meta) {
  const el = document.createElement("div");
  el.className = "hush-card hush-card-ghost";
  el.style.width = `${cardSize(meta).width}px`;
  if (meta?.bgColor) { el.style.setProperty("--card-accent", meta.bgColor); el.classList.add("has-color"); }
  if (meta?.collapsed) el.classList.add("collapsed");
  if (cardWordCount(body) > CARD_MAX_WORDS) el.classList.add("over-limit");
  const header = document.createElement("div");
  header.className = "hush-card-header";
  header.innerHTML = `<span class="hush-card-grip">${ICONS.grip}</span><span class="hush-card-title"></span>`;
  header.querySelector(".hush-card-title").textContent = cardTitle(body);
  const text = document.createElement("div");
  text.className = "hush-card-body hush-card-ghost-text";
  text.textContent = body;
  el.append(header, text);
  return el;
}
