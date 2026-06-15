/**
 * Shuffle Editor — a revision mode that breaks the active selection apart
 * into sentences and lets the user creatively recombine them.
 *
 * Like Zen Focus it mounts a fullscreen overlay above every other piece
 * of chrome; like Selection Focus it captures the active editor selection
 * and (on accept) writes the result back over that range. In between,
 * every sentence is a draggable / editable *node*: the centre column is a
 * vertical list of sentence nodes spaced apart (not a continuous flow),
 * flanked by lightly-tinted margins where loose nodes live as 280 px
 * wrapped chips.
 *
 *   • Hover a node — column or margin — to highlight it; drag to move it.
 *     Dropping into the column inserts it at that position; dropping in a
 *     margin parks it as a chip; dropping one margin node onto another
 *     combines them (the follower joins as a continuing clause and the
 *     target's trailing punctuation drops).
 *   • A plain click edits a node in place. Typing concluding punctuation
 *     divides a node into one capitalized node per sentence.
 *   • Double-click a margin (or the space between sentences in the column)
 *     to create a fresh node to type into.
 *   • The Shuffle button reshuffles every node still in the margins.
 *   • Undo (Cmd/Ctrl+Z) steps back through structural changes, so a node
 *     dragged into the column returns to the margin.
 *   • Closing offers the original beside the recombined version.
 *
 * Sentence mode only for now; word / paragraph modes are planned. State is
 * transient (payload on `state._shuffleEditorPayload`) so a saved-state
 * layer can be added later without reworking capture / write-back.
 */

import { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { getActiveModeContext } from "../state/mode-context.js";
import {
  splitIntoSentences, capitalizeFirst, combineInto, startDragGesture,
} from "./shuffle-editor-dnd.js";

const CHIP_WIDTH = 280; // px — the "300px wrapped" margin form (incl. padding)
const MARGIN_GAP = 16;
const CHIP_V_GAP = 12;

let active = null;
let nodeSeq = 0;

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
  const marginLayer = el("div", "shuffle-margin-layer");
  const column = el("div", "shuffle-editor-column");
  column.style.width = `${Math.min(payload.columnWidth, 900)}px`;
  canvas.appendChild(marginLayer);
  canvas.appendChild(column);
  overlay.appendChild(canvas);

  document.body.classList.add("shuffle-editor-active");
  document.body.appendChild(overlay);

  const toolbar = buildToolbar();
  overlay.appendChild(toolbar.el);

  active = {
    state, payload, overlay, canvas, marginLayer, column,
    editorNodes: [],   // ordered list rendered in the centre column
    marginNodes: [],    // loose chips in the margins
    history: [],        // structural-undo snapshots
    ghost: null,
  };
  const ctrl = buildController(active);
  active.ctrl = ctrl;

  // Every sentence starts life as a margin node.
  for (const text of splitIntoSentences(payload.text)) {
    active.marginNodes.push(makeNode(text, "margin"));
  }
  ctrl.render();
  ctrl.layoutMargins();

  toolbar.shuffleBtn.addEventListener("click", () => ctrl.shuffleMargins());
  toolbar.doneBtn.addEventListener("click", () => beginClose());

  // Double-click an empty margin to spawn a node to type into.
  canvas.addEventListener("dblclick", (e) => {
    if (e.target !== canvas && e.target !== marginLayer) return;
    ctrl.createMarginNodeAt(e.clientX, e.clientY);
  });

  const onKeydown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      if (active && active.compare) { dismissCompare(); return; }
      beginClose();
      return;
    }
    const meta = e.metaKey || e.ctrlKey;
    if (meta && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
      // Let the browser handle text undo inside a node being edited;
      // otherwise step back through structural changes.
      const ae = document.activeElement;
      if (ae && ae.classList?.contains("shuffle-node") && ae.isContentEditable) return;
      e.preventDefault();
      ctrl.undo();
    }
  };
  document.addEventListener("keydown", onKeydown, true);
  active.cleanups = [() => document.removeEventListener("keydown", onKeydown, true)];

  const onResize = () => ctrl.reflowOnResize();
  window.addEventListener("resize", onResize);
  active.cleanups.push(() => window.removeEventListener("resize", onResize));
}

function exitShuffleEditor() {
  if (!active) return;
  const a = active;
  active = null;
  for (const fn of (a.cleanups || [])) { try { fn(); } catch (_) {} }
  if (a.ghost) { try { a.ghost.remove(); } catch (_) {} }
  a.overlay.remove();
  document.body.classList.remove("shuffle-editor-active");
  a.state._shuffleEditorPayload = null;
}

/* ===== Node model ===== */

function makeNode(text, where, x = 0, y = 0) {
  return { id: ++nodeSeq, text, where, x, y, editing: false, el: null };
}

/* ===== Controller ===== */

function buildController(a) {
  const { canvas, marginLayer, column } = a;

  /* ----- geometry ----- */
  function canvasRect() { return canvas.getBoundingClientRect(); }
  function clientToCanvas(cx, cy) {
    const r = canvasRect();
    return { x: cx - r.left, y: cy - r.top };
  }
  function clampX(x) {
    const max = Math.max(8, canvas.clientWidth - CHIP_WIDTH - 8);
    return Math.max(8, Math.min(max, x));
  }
  function pointInColumn(cx, cy) {
    const r = column.getBoundingClientRect();
    return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  }
  function growCanvas() {
    let bottom = column.offsetTop + column.offsetHeight;
    for (const n of a.marginNodes) {
      if (n.el) bottom = Math.max(bottom, n.y + n.el.offsetHeight);
    }
    canvas.style.minHeight = `${Math.max(window.innerHeight, bottom + 80)}px`;
  }

  /* ----- rendering ----- */
  function makeGap(index) {
    const gap = el("div", "shuffle-gap");
    gap.dataset.index = String(index);
    gap.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      ctrl.createEditorNodeAt(index);
    });
    return gap;
  }

  function makeNodeEl(node, variant) {
    const node_el = el("div", `shuffle-node ${variant}`);
    node_el.textContent = node.text;
    node.el = node_el;
    wireNode(node);
    return node_el;
  }

  function render() {
    // Centre column: gap, node, gap, node, …, gap.
    column.innerHTML = "";
    column.appendChild(makeGap(0));
    a.editorNodes.forEach((node, i) => {
      column.appendChild(makeNodeEl(node, "in-editor"));
      column.appendChild(makeGap(i + 1));
    });
    // Margins.
    marginLayer.innerHTML = "";
    for (const node of a.marginNodes) {
      const node_el = makeNodeEl(node, "in-margin");
      node_el.style.width = `${CHIP_WIDTH}px`;
      node_el.style.left = `${node.x}px`;
      node_el.style.top = `${node.y}px`;
      marginLayer.appendChild(node_el);
    }
    growCanvas();
  }

  /* ----- per-node interactions ----- */
  function wireNode(node) {
    const node_el = node.el;
    node_el.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || node.editing) return;
      e.preventDefault(); // suppress text selection / native drag
      const preSnapshot = serialize();
      startDragGesture(e, {
        onBegin: () => {
          pushSnapshot(preSnapshot);
          detachNode(node);              // remove from model — no faint leftover
          a.ghost = makeGhost(node.text);
        },
        onMove: (ev) => moveGhost(a.ghost, ev.clientX, ev.clientY),
        onDrop: (ev) => { removeGhost(); dropNode(node, ev.clientX, ev.clientY); },
        onClick: (ev) => editNode(node, ev),
      });
    });
    node_el.addEventListener("input", (e) => onNodeInput(node, e));
    node_el.addEventListener("blur", () => commitEdit(node));
  }

  function editNode(node, ev) {
    node.editing = true;
    node.el.classList.add("editing");
    node.el.contentEditable = "true";
    node.el.focus();
    placeCaretAtPoint(node.el, ev.clientX, ev.clientY);
  }

  function commitEdit(node) {
    if (!node.editing) return;
    node.editing = false;
    node.el.classList.remove("editing");
    node.el.contentEditable = "false";
    node.text = capitalizeFirst(node.el.textContent.trim());
    if (!node.text) { removeNode(node); return; }
    node.el.textContent = node.text;
  }

  function onNodeInput(node, e) {
    node.text = node.el.textContent;
    if (e.data !== "." && e.data !== "!" && e.data !== "?") return;
    const parts = splitIntoSentences(node.el.textContent);
    if (parts.length > 1) splitNode(node, parts);
  }

  /* ----- structural ops ----- */
  function detachNode(node) {
    a.editorNodes = a.editorNodes.filter((n) => n !== node);
    a.marginNodes = a.marginNodes.filter((n) => n !== node);
    render();
  }

  function removeNode(node) {
    pushSnapshot(serialize());
    detachNode(node);
  }

  function findNodeByEl(node_el) {
    return a.editorNodes.find((n) => n.el === node_el)
      || a.marginNodes.find((n) => n.el === node_el)
      || null;
  }

  function editorIndexAt(clientY) {
    for (let i = 0; i < a.editorNodes.length; i++) {
      const r = a.editorNodes[i].el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return a.editorNodes.length;
  }

  function dropNode(node, cx, cy) {
    const hit = document.elementFromPoint(cx, cy);
    const overMargin = hit?.closest?.(".shuffle-node.in-margin");
    if (overMargin && !pointInColumn(cx, cy)) {
      const target = findNodeByEl(overMargin);
      if (target && target !== node) { target.text = combineInto(target.text, node.text); render(); return; }
    }
    if (pointInColumn(cx, cy)) {
      node.where = "editor";
      a.editorNodes.splice(editorIndexAt(cy), 0, node);
      render();
      return;
    }
    // Park as a margin chip at the drop point.
    node.where = "margin";
    const p = clientToCanvas(cx, cy);
    node.x = clampX(p.x - CHIP_WIDTH / 2);
    node.y = Math.max(8, p.y - 16);
    a.marginNodes.push(node);
    render();
  }

  function splitNode(node, parts) {
    pushSnapshot(serialize());
    node.text = capitalizeFirst(parts[0].trim());
    node.editing = false;
    const rest = parts.slice(1).map((p) => capitalizeFirst(p.trim()));
    if (node.where === "editor") {
      const idx = a.editorNodes.indexOf(node);
      a.editorNodes.splice(idx + 1, 0, ...rest.map((t) => makeNode(t, "editor")));
    } else {
      let y = node.y;
      for (const t of rest) { y += 44; a.marginNodes.push(makeNode(t, "margin", node.x, y)); }
    }
    render();
  }

  function createEditorNodeAt(index) {
    pushSnapshot(serialize());
    const node = makeNode("", "editor");
    a.editorNodes.splice(index, 0, node);
    render();
    editNode(node, fakeCenterEvent(node.el));
  }

  function createMarginNodeAt(cx, cy) {
    pushSnapshot(serialize());
    const p = clientToCanvas(cx, cy);
    const node = makeNode("", "margin", clampX(p.x - CHIP_WIDTH / 2), Math.max(8, p.y - 16));
    a.marginNodes.push(node);
    render();
    editNode(node, { clientX: cx, clientY: cy });
  }

  /* ----- ghost ----- */
  function makeGhost(text) {
    const g = el("div", "shuffle-node in-margin shuffle-ghost");
    g.style.width = `${CHIP_WIDTH}px`;
    g.textContent = text;
    document.body.appendChild(g);
    return g;
  }
  function moveGhost(g, cx, cy) {
    if (!g) return;
    g.style.left = `${cx - CHIP_WIDTH / 2}px`;
    g.style.top = `${cy - 16}px`;
  }
  function removeGhost() { if (a.ghost) { a.ghost.remove(); a.ghost = null; } }

  /* ----- layout ----- */
  function layoutMargins() {
    const cr = canvasRect();
    const colR = column.getBoundingClientRect();
    const colLeft = colR.left - cr.left;
    const colRight = colR.right - cr.left;
    const leftCol = Math.max(8, colLeft - CHIP_WIDTH - MARGIN_GAP);
    const rightCol = clampX(colRight + MARGIN_GAP);
    let ly = 24;
    let ry = 24;
    a.marginNodes.forEach((node, i) => {
      const onLeft = i % 2 === 0;
      node.x = onLeft ? leftCol : rightCol;
      node.y = onLeft ? ly : ry;
      if (!node.el) return;
      node.el.style.left = `${node.x}px`;
      node.el.style.top = `${node.y}px`;
      const h = node.el.offsetHeight + CHIP_V_GAP;
      if (onLeft) ly += h; else ry += h;
    });
    growCanvas();
  }

  function reflowOnResize() {
    for (const node of a.marginNodes) {
      node.x = clampX(node.x);
      if (node.el) node.el.style.left = `${node.x}px`;
    }
    growCanvas();
  }

  function shuffleMargins() {
    for (let i = a.marginNodes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a.marginNodes[i], a.marginNodes[j]] = [a.marginNodes[j], a.marginNodes[i]];
    }
    render();
    layoutMargins();
  }

  /* ----- undo ----- */
  function serialize() {
    return {
      editor: a.editorNodes.map((n) => ({ text: n.text })),
      margin: a.marginNodes.map((n) => ({ text: n.text, x: n.x, y: n.y })),
    };
  }
  function pushSnapshot(snap) {
    a.history.push(snap);
    if (a.history.length > 120) a.history.shift();
  }
  function undo() {
    const snap = a.history.pop();
    if (!snap) return;
    a.editorNodes = snap.editor.map((s) => makeNode(s.text, "editor"));
    a.marginNodes = snap.margin.map((s) => makeNode(s.text, "margin", s.x, s.y));
    render();
  }

  const ctrl = {
    render, layoutMargins, reflowOnResize, shuffleMargins, undo,
    createEditorNodeAt, createMarginNodeAt,
    editorText: () => a.editorNodes.map((n) => n.text).join(" ").trim(),
  };
  return ctrl;
}

/* ===== Close / compare ===== */

function beginClose() {
  if (!active || active.compare) return;
  showCompare(active.payload.text, active.ctrl.editorText());
}

function showCompare(originalText, newText) {
  const back = el("div", "shuffle-compare-backdrop");
  const modal = el("div", "shuffle-compare-modal");
  modal.innerHTML = `
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
  modal.querySelector('[data-role="shuffled"]').textContent = newText || "(empty)";
  back.appendChild(modal);
  active.overlay.appendChild(back);
  active.compare = back;

  modal.querySelector(".shuffle-compare-cancel")
    .addEventListener("click", () => dismissCompare());
  modal.querySelector(".shuffle-compare-keep-original")
    .addEventListener("click", () => finalize(null));
  modal.querySelector(".shuffle-compare-keep-shuffled")
    .addEventListener("click", () => finalize(newText));
}

function dismissCompare() {
  if (!active || !active.compare) return;
  active.compare.remove();
  active.compare = null;
}

/** `content === null` keeps the original (no write-back); a string writes
 *  it back over the source range. */
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

/** Best-effort caret placement at a client point inside a contenteditable;
 *  falls back to the end of the node. */
function placeCaretAtPoint(node_el, cx, cy) {
  const sel = window.getSelection();
  let range = null;
  if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(cx, cy);
  else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(cx, cy);
    if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
  }
  sel.removeAllRanges();
  if (range && node_el.contains(range.startContainer)) {
    range.collapse(true);
    sel.addRange(range);
  } else {
    const r = document.createRange();
    r.selectNodeContents(node_el);
    r.collapse(false);
    sel.addRange(r);
  }
}

/** A synthetic event positioned at a node's centre — used to seed caret
 *  placement when a node is created (rather than clicked). */
function fakeCenterEvent(node_el) {
  const r = node_el.getBoundingClientRect();
  return { clientX: r.left + 12, clientY: r.top + r.height / 2 };
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
