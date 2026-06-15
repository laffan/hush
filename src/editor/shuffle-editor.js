/**
 * Shuffle Editor — a revision mode that breaks the active selection apart
 * into sentences and lets the user creatively recombine them.
 *
 * Like Zen Focus it mounts a fullscreen overlay above every other piece
 * of chrome; like Selection Focus it captures the active editor selection
 * and (on accept) writes the result back over that range as a single
 * transaction. In between, the user works in a two-part surface: a real
 * CodeMirror editor sits in the centre with a light boundary, and the
 * sentences start life as draggable 300 px chips spread through the
 * margins around it.
 *
 *   • Hovering a sentence — in the editor or as a margin chip — highlights
 *     it; dragging picks it up. Dropping into the editor reflows it as
 *     normal text; dragging it back out re-assumes the wrapped chip form.
 *   • A plain click (no drag) edits the sentence in place, inside or out.
 *   • The Shuffle button reshuffles every sentence still in the margins.
 *   • Closing offers the original beside the recombined version; the user
 *     keeps either, or cancels back into the shuffle surface.
 *
 * This first iteration handles sentence mode only. Word / paragraph modes
 * are planned but not yet surfaced.
 *
 * State / persistence is deliberately left out for now — the mode runs off
 * a transient payload (`state._shuffleEditorPayload`) the way Selection
 * Focus does, so a saved-state layer can be added later without reworking
 * the capture / write-back path.
 */

import { EditorView } from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";
import { createBaseExtensions } from "./base-extensions.js";
import { applyBlockCursor } from "./block-cursor.js";
import { getActiveModeContext } from "../state/mode-context.js";
import {
  splitIntoSentences, shuffleHoverExtension,
  installEditorSentenceDrag, installChipDrag,
} from "./shuffle-editor-dnd.js";

const CHIP_WIDTH = 280; // px — the "300px wrapped" margin form (incl. padding)
const MARGIN_GAP = 16;
const CHIP_V_GAP = 12;

let active = null;
let chipSeq = 0;

export function initShuffleEditor(state) {
  state.on("shuffle-editor-changed", () => {
    if (state.shuffleEditor) enterShuffleEditor(state);
    else exitShuffleEditor(state);
  });
}

/* ===== Capture / availability (mirrors Selection Focus) ===== */

/** Hunt for an editor surface with a non-empty selection and return the
 *  payload the overlay mounts against. Priority: the active mode context
 *  (focused pane / stack column) > the main editor. Returns null when
 *  nothing is selected. */
export function captureShufflePayload(state) {
  const candidates = [];
  const ctx = getActiveModeContext(state);
  if (ctx?.view) candidates.push(ctx.view);
  if (state.editor?.view && !candidates.includes(state.editor.view)) {
    candidates.push(state.editor.view);
  }
  for (const v of candidates) {
    try {
      const sel = v.state.selection.main;
      if (sel.empty) continue;
      const text = v.state.sliceDoc(sel.from, sel.to);
      if (!text.trim()) continue;
      const rect = (v.contentDOM || v.dom).getBoundingClientRect();
      const columnWidth = Math.max(360, Math.round(rect.width));
      return { sourceView: v, from: sel.from, to: sel.to, text, columnWidth };
    } catch (_) { /* try next candidate */ }
  }
  return null;
}

/** Palette gate — the Shuffle command only shows with a live selection. */
export function shuffleSelectionAvailable(state) {
  return !!captureShufflePayload(state);
}

/** Open the Shuffle Editor on the current selection. Returns false (so the
 *  caller can fall through) when there's nothing selected. */
export function openShuffleEditor(state) {
  const payload = captureShufflePayload(state);
  if (!payload) return false;
  state.toggleShuffleEditor(payload);
  return true;
}

/* ===== Lifecycle ===== */

function enterShuffleEditor(state) {
  if (active) return;
  const payload = state._shuffleEditorPayload;
  if (!payload || !payload.text) { state.shuffleEditor = false; return; }

  const overlay = el("div", "shuffle-editor-overlay");
  const canvas = el("div", "shuffle-editor-canvas");
  const stage = el("div", "shuffle-editor-stage");
  stage.style.width = `${Math.min(payload.columnWidth, 900)}px`;
  canvas.appendChild(stage);
  overlay.appendChild(canvas);

  document.body.classList.add("shuffle-editor-active");
  document.body.appendChild(overlay);
  applyBlockCursor(state);

  // Center editor starts empty — every sentence begins life in a margin.
  const { extensions } = createBaseExtensions(state, () => { /* no per-keystroke sync */ });
  const view = new EditorView({
    state: EditorState.create({
      doc: "",
      extensions: [...extensions, shuffleHoverExtension()],
    }),
    parent: stage,
  });
  const styleFg = getComputedStyle(document.documentElement)
    .getPropertyValue("--style-fg").trim();
  if (styleFg) view.dom.style.color = styleFg;

  const toolbar = buildToolbar();
  overlay.appendChild(toolbar.el);

  active = {
    state, payload, overlay, canvas, stage, view,
    chips: [],
    ghosts: new Set(),
    cleanups: [],
  };

  const ctrl = buildController(active);
  active.ctrl = ctrl;

  // Seed margin chips from the captured selection and lay them out.
  for (const text of splitIntoSentences(payload.text)) ctrl.addChip(text);
  ctrl.layoutChips();

  active.cleanups.push(installEditorSentenceDrag(ctrl));

  toolbar.shuffleBtn.addEventListener("click", () => ctrl.shuffleMargins());
  toolbar.doneBtn.addEventListener("click", () => beginClose());

  const onKeydown = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (active && active.compare) { dismissCompare(); return; }
    beginClose();
  };
  document.addEventListener("keydown", onKeydown, true);
  active.cleanups.push(() => document.removeEventListener("keydown", onKeydown, true));

  const onResize = () => ctrl.reflowOnResize();
  window.addEventListener("resize", onResize);
  active.cleanups.push(() => window.removeEventListener("resize", onResize));

  view.focus();
}

function exitShuffleEditor() {
  if (!active) return;
  const a = active;
  active = null;
  for (const fn of a.cleanups) { try { fn(); } catch (_) {} }
  for (const g of a.ghosts) { try { g.remove(); } catch (_) {} }
  try { a.view.destroy(); } catch (_) {}
  a.overlay.remove();
  document.body.classList.remove("shuffle-editor-active");
  a.state._shuffleEditorPayload = null;
}

/* ===== Controller — the surface API the DnD module drives ===== */

function buildController(a) {
  const { canvas, stage, view, overlay } = a;

  function canvasRect() { return canvas.getBoundingClientRect(); }

  function clientToCanvas(clientX, clientY) {
    const r = canvasRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  function clampX(x) {
    const max = Math.max(8, canvas.clientWidth - CHIP_WIDTH - 8);
    return Math.max(8, Math.min(max, x));
  }

  function makeChipEl(text) {
    const el2 = el("div", "shuffle-chip");
    el2.style.width = `${CHIP_WIDTH}px`;
    el2.textContent = text;
    canvas.appendChild(el2);
    return el2;
  }

  const ctrl = {
    view,

    addChip(text, x, y) {
      const chip = { id: ++chipSeq, text, editing: false, el: makeChipEl(text), x: x ?? 0, y: y ?? 0 };
      positionChip(chip);
      installChipDrag(ctrl, chip);
      a.chips.push(chip);
      return chip;
    },

    removeChip(chip) {
      chip.el.remove();
      a.chips = a.chips.filter((c) => c !== chip);
    },

    editChip(chip) {
      chip.editing = true;
      chip.el.classList.add("editing");
      chip.el.contentEditable = "true";
      chip.el.focus();
      const onBlur = () => {
        chip.editing = false;
        chip.el.classList.remove("editing");
        chip.el.contentEditable = "false";
        chip.text = chip.el.textContent.trim();
        if (!chip.text) ctrl.removeChip(chip);
        chip.el.removeEventListener("blur", onBlur);
      };
      chip.el.addEventListener("blur", onBlur);
    },

    /** Reposition an existing chip to a drop point given in client coords. */
    placeChipAtClient(chip, clientX, clientY) {
      const p = clientToCanvas(clientX, clientY);
      chip.x = clampX(p.x - CHIP_WIDTH / 2);
      chip.y = Math.max(8, p.y - 16);
      positionChip(chip);
      growCanvas();
    },

    /** Spawn a brand-new chip (dragged out of the editor) at a drop point. */
    dropChipAtClient(text, clientX, clientY) {
      const p = clientToCanvas(clientX, clientY);
      ctrl.addChip(text, clampX(p.x - CHIP_WIDTH / 2), Math.max(8, p.y - 16));
      growCanvas();
    },

    isOverEditor(clientX, clientY) {
      const r = view.contentDOM.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    },

    insertSentenceIntoEditor(text, clientX, clientY) {
      let pos = view.posAtCoords({ x: clientX, y: clientY });
      if (pos == null) pos = view.state.doc.length;
      const doc = view.state.doc;
      const before = pos > 0 ? doc.sliceString(pos - 1, pos) : "";
      const after = pos < doc.length ? doc.sliceString(pos, pos + 1) : "";
      let insert = text;
      if (before && !/\s/.test(before)) insert = " " + insert;
      if (after && !/\s/.test(after)) insert = insert + " ";
      view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
      view.focus();
    },

    /* ----- ghost element shared by both drag gestures ----- */
    makeGhost(text) {
      const g = el("div", "shuffle-chip shuffle-chip-ghost");
      g.style.width = `${CHIP_WIDTH}px`;
      g.textContent = text;
      document.body.appendChild(g);
      a.ghosts.add(g);
      return g;
    },
    moveGhost(g, clientX, clientY) {
      g.style.left = `${clientX - CHIP_WIDTH / 2}px`;
      g.style.top = `${clientY - 16}px`;
    },
    removeGhost(g) { if (g) { g.remove(); a.ghosts.delete(g); } },

    /* ----- layout ----- */
    layoutChips() {
      const r = stage.getBoundingClientRect();
      const cr = canvasRect();
      const stageLeft = r.left - cr.left;
      const stageRight = r.right - cr.left;
      const leftCol = Math.max(8, stageLeft - CHIP_WIDTH - MARGIN_GAP);
      const rightCol = clampX(stageRight + MARGIN_GAP);
      let leftY = 24;
      let rightY = 24;
      a.chips.forEach((chip, i) => {
        const onLeft = i % 2 === 0;
        chip.x = onLeft ? leftCol : rightCol;
        chip.y = onLeft ? leftY : rightY;
        positionChip(chip);
        const h = chip.el.offsetHeight + CHIP_V_GAP;
        if (onLeft) leftY += h; else rightY += h;
      });
      growCanvas();
    },

    reflowOnResize() {
      // Push margin chips inward so the surface never scrolls horizontally.
      for (const chip of a.chips) { chip.x = clampX(chip.x); positionChip(chip); }
      growCanvas();
    },

    shuffleMargins() {
      for (let i = a.chips.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a.chips[i], a.chips[j]] = [a.chips[j], a.chips[i]];
      }
      ctrl.layoutChips();
    },
  };

  function positionChip(chip) {
    chip.el.style.left = `${chip.x}px`;
    chip.el.style.top = `${chip.y}px`;
  }

  function growCanvas() {
    let bottom = stage.offsetTop + stage.offsetHeight;
    for (const chip of a.chips) bottom = Math.max(bottom, chip.y + chip.el.offsetHeight);
    canvas.style.minHeight = `${bottom + 80}px`;
  }

  // expose for resize re-measure of the stage column
  ctrl._overlay = overlay;
  return ctrl;
}

/* ===== Close / compare ===== */

function beginClose() {
  if (!active || active.compare) return;
  const originalText = active.payload.text;
  const newText = active.view.state.doc.toString();
  showCompare(originalText, newText);
}

function showCompare(originalText, newText) {
  const back = el("div", "shuffle-compare-backdrop");
  const modal = el("div", "shuffle-compare-modal");
  modal.innerHTML = `
    <div class="shuffle-compare-title">Keep which version?</div>
    <div class="shuffle-compare-cols">
      <div class="shuffle-compare-col">
        <div class="shuffle-compare-label">Original</div>
        <div class="shuffle-compare-text" data-role="original"></div>
      </div>
      <div class="shuffle-compare-col">
        <div class="shuffle-compare-label">Shuffled</div>
        <div class="shuffle-compare-text" data-role="shuffled"></div>
      </div>
    </div>
    <div class="shuffle-compare-btns">
      <button class="shuffle-compare-cancel">Cancel</button>
      <button class="shuffle-compare-keep-original">Keep Original</button>
      <button class="shuffle-compare-keep-shuffled">Keep Shuffled</button>
    </div>`;
  modal.querySelector('[data-role="original"]').textContent = originalText;
  modal.querySelector('[data-role="shuffled"]').textContent = newText.trim() || "(empty)";
  back.appendChild(modal);
  active.overlay.appendChild(back);
  active.compare = back;

  modal.querySelector(".shuffle-compare-cancel")
    .addEventListener("click", () => dismissCompare());
  modal.querySelector(".shuffle-compare-keep-original")
    .addEventListener("click", () => finalize(null));
  modal.querySelector(".shuffle-compare-keep-shuffled")
    .addEventListener("click", () => finalize(newText.trim()));
}

function dismissCompare() {
  if (!active || !active.compare) return;
  active.compare.remove();
  active.compare = null;
  try { active.view.focus(); } catch (_) {}
}

/** Resolve the session. `content === null` keeps the original (no
 *  write-back); a string writes that content back over the source range. */
function finalize(content) {
  if (!active) return;
  const { state, payload } = active;
  if (typeof content === "string") writeBack(payload, content);
  state.toggleShuffleEditor(); // tears the overlay down via the listener
}

function writeBack(payload, content) {
  try {
    const src = payload.sourceView;
    if (!src || !src.state) return;
    const docLen = src.state.doc.length;
    const from = Math.max(0, Math.min(payload.from, docLen));
    const to = Math.max(from, Math.min(payload.to, docLen));
    const caret = from + content.length;
    src.dispatch({
      changes: { from, to, insert: content },
      selection: EditorSelection.range(caret, caret),
    });
    src.dispatch({ effects: EditorView.scrollIntoView(caret, { y: "center" }) });
    src.focus();
  } catch (_) { /* source went away mid-shuffle */ }
}

/* ===== Small DOM helpers ===== */

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function buildToolbar() {
  const wrap = el("div", "shuffle-editor-toolbar");
  const shuffleBtn = el("button", "shuffle-editor-btn shuffle-editor-shuffle");
  shuffleBtn.textContent = "Shuffle";
  const doneBtn = el("button", "shuffle-editor-btn shuffle-editor-done");
  doneBtn.textContent = "Done";
  wrap.appendChild(shuffleBtn);
  wrap.appendChild(doneBtn);
  return { el: wrap, shuffleBtn, doneBtn };
}
