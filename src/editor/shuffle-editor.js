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

import {
  splitIntoSentences, capitalizeFirst, combineInto, startDragGesture,
  buildToolbar, placeCaretAtPoint, fakeCenterEvent, buildCompareModal,
  findFreeMarginSpot, snapMarginToGutter,
} from "./shuffle-editor-dnd.js";
import {
  captureAnyShufflePayload, shuffleSelectionAvailable, writeBackShuffle,
} from "./shuffle-editor-source.js";
import { renderShuffleMarkdown } from "./shuffle-editor-markdown.js";
import { installShuffleKeyboard } from "./shuffle-editor-keys.js";
import { createShuffleHistory } from "./shuffle-editor-history.js";

export { shuffleSelectionAvailable };

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

/* ===== Open ===== */

/** Open the Shuffle Editor on the current selection. `config` picks the
 *  start layout: "explode" (every sentence in the margins — the default),
 *  "list-current" (every sentence already in the column, in order), or
 *  "list-shuffle" (in the column, shuffled). Returns false (so the caller
 *  can fall through) when there's nothing selected. */
export function openShuffleEditor(state, config = "explode") {
  const payload = captureAnyShufflePayload(state);
  if (!payload) return false;
  payload.config = config;
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
  // Match the source editor's text size (margin chips stay relative).
  const fontPx = payload.fontSizePx || 16;
  column.style.fontSize = `${fontPx}px`;
  marginLayer.style.fontSize = `${fontPx}px`;
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
    redoStack: [],      // snapshots popped by undo, replayable via redo
    ghost: null,
    preview: null,      // live drop-position preview shown over the column
    dragText: "",       // text of the node being dragged
    dragGrab: { x: CHIP_WIDTH / 2, y: 16 }, // grab offset for the active drag
    hoverNode: null,    // node under the pointer (drives a/d/s/c shortcuts)
    focusNode: null,    // focused column node (drives cmd/shift arrow nav)
    editingNode: null,  // node currently being text-edited
  };
  const ctrl = buildController(active);
  active.ctrl = ctrl;

  // Seed the start layout from the chosen config.
  const sentences = splitIntoSentences(payload.text);
  if ((payload.config || "explode") === "explode") {
    for (const text of sentences) active.marginNodes.push(makeNode(text, "margin"));
  } else {
    const list = sentences.slice();
    if (payload.config === "list-shuffle") {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
    }
    for (const text of list) active.editorNodes.push(makeNode(text, "editor"));
  }
  active.focusNode = active.editorNodes[0] || null; // seed for arrow nav
  ctrl.render();
  ctrl.layoutMargins();

  toolbar.shuffleBtn.addEventListener("click", () => ctrl.shuffleMargins());
  toolbar.cancelBtn.addEventListener("click", () => finalize(null));
  toolbar.doneBtn.addEventListener("click", () => beginClose());

  // Double-click an empty margin to spawn a node to type into.
  canvas.addEventListener("dblclick", (e) => {
    if (e.target !== canvas && e.target !== marginLayer) return;
    ctrl.createMarginNodeAt(e.clientX, e.clientY);
  });

  active.cleanups = [installShuffleKeyboard(active, ctrl, { beginClose, dismissCompare })];

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
  return {
    id: ++nodeSeq, text, where, x, y,
    editing: false, strike: false, comment: false,
    el: null, textEl: null,
  };
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
  // Keep a parked margin chip clear of the centre column (geometry lives in
  // snapMarginToGutter so this file stays under the line cap).
  function snapMarginX(x) {
    const cr = canvasRect(), colR = column.getBoundingClientRect();
    return snapMarginToGutter(x, { canvasW: canvas.clientWidth, chipW: CHIP_WIDTH,
      gap: MARGIN_GAP, colLeft: colR.left - cr.left, colRight: colR.right - cr.left });
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
    const wrap = el("div", `shuffle-node ${variant}`);
    wrap.classList.toggle("struck", !!node.strike); wrap.classList.toggle("commented", !!node.comment);
    const textEl = el("div", "shuffle-node-text"); textEl.innerHTML = renderShuffleMarkdown(node.text);
    wrap.appendChild(textEl);
    wrap.appendChild(buildNodeTools(node));
    node.el = wrap; node.textEl = textEl;
    wireNode(node);
    return wrap;
  }

  /** The `~~` (strike) and `%%` (comment) toggles that ride beside each
   *  node. Struck nodes are dropped on close; commented nodes move beneath
   *  the text as a `%%…%%` comment. */
  function buildNodeTools(node) {
    const tools = el("div", "shuffle-node-tools");
    const mk = (label, flag, title) => {
      const b = el("button", `shuffle-node-tool${node[flag] ? " active" : ""}`);
      b.textContent = label;
      b.title = title;
      b.addEventListener("mousedown", (e) => { e.stopPropagation(); e.preventDefault(); });
      b.addEventListener("click", (e) => { e.stopPropagation(); toggleFlag(node, flag); });
      return b;
    };
    tools.appendChild(mk("~~", "strike", "Strike out — removed on close"));
    tools.appendChild(mk("%%", "comment", "Comment — moved beneath the text on close"));
    return tools;
  }

  function toggleFlag(node, flag) {
    pushSnapshot(serialize());
    node[flag] = !node[flag];
    render();
  }

  function render() {
    // Centre column: gap, node, gap, node, …, gap.
    column.innerHTML = "";
    column.appendChild(makeGap(0));
    a.editorNodes.forEach((node, i) => {
      const node_el = makeNodeEl(node, "in-editor");
      if (node === a.focusNode) node_el.classList.add("focused");
      column.appendChild(node_el);
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
    node.el.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || node.editing) return;
      if (e.target.closest(".shuffle-node-tools")) return; // tool button, not a drag
      e.preventDefault(); // suppress text selection / native drag
      const preSnapshot = serialize();
      // Grab offset (clamped to chip width) so a margin drag never jumps.
      const rect = node.el.getBoundingClientRect();
      const grab = {
        x: Math.max(0, Math.min(CHIP_WIDTH, e.clientX - rect.left)),
        y: Math.max(0, Math.min(60, e.clientY - rect.top)),
      };
      startDragGesture(e, {
        onBegin: () => {
          pushSnapshot(preSnapshot);
          a.dragGrab = grab;
          a.dragText = node.text;
          detachNode(node);              // remove from model — no faint leftover
          a.ghost = makeGhost(node.text);
        },
        onMove: (ev) => { positionGhost(ev.clientX, ev.clientY); updateDropPreview(ev.clientX, ev.clientY); },
        onDrop: (ev) => { removePreview(); removeGhost(); dropNode(node, ev.clientX, ev.clientY); },
        onClick: (ev) => editNode(node, ev),
      });
    });
    node.textEl.addEventListener("input", (e) => onNodeInput(node, e));
    node.textEl.addEventListener("blur", () => commitEdit(node));
    // Track the hovered node so the a / d / s / c shortcuts know their target.
    node.el.addEventListener("mouseenter", () => { a.hoverNode = node; });
    node.el.addEventListener("mouseleave", () => { if (a.hoverNode === node) a.hoverNode = null; });
  }

  /** Enter edit mode: swap rendered markdown back to raw text, then focus. */
  function beginEdit(node) {
    node.editing = true;
    a.editingNode = node;
    // Remember the text as it stood before this edit so commitEdit can
    // record an undo checkpoint that restores it.
    node.preEditText = node.text;
    node.el.classList.add("editing");
    node.textEl.textContent = node.text;
    node.textEl.contentEditable = "true";
    node.textEl.focus();
  }

  function editNode(node, ev) {
    beginEdit(node);
    placeCaretAtPoint(node.textEl, ev.clientX, ev.clientY);
  }

  /** Re-enter edit on a node with the caret parked at the end. */
  function reEditAtEnd(node) {
    beginEdit(node);
    const sel = window.getSelection();
    const r = document.createRange();
    r.selectNodeContents(node.textEl);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function commitEdit(node) {
    if (!node.editing) return;
    node.editing = false;
    if (a.editingNode === node) a.editingNode = null;
    node.el.classList.remove("editing");
    node.textEl.contentEditable = "false";
    const preEdit = typeof node.preEditText === "string" ? node.preEditText : node.text;
    node.text = capitalizeFirst(node.textEl.textContent.trim());
    if (!node.text) {
      // Committing an emptied sentence removes the node. Restore the
      // pre-edit text first so the removal snapshot preserves the
      // sentence — undo brings the words back, not an empty chip.
      node.text = preEdit;
      if (node.text) removeNode(node); else detachNode(node);
      return;
    }
    // Text edits are undoable structural steps too: record the pre-edit
    // state (everything else as it stands now, this node's old text).
    if (node.text !== preEdit) pushSnapshot(serializeWithNodeText(node, preEdit));
    node.textEl.innerHTML = renderShuffleMarkdown(node.text);
  }

  function onNodeInput(node, e) {
    node.text = node.textEl.textContent;
    if (e.data !== "." && e.data !== "!" && e.data !== "?") return;
    const parts = splitIntoSentences(node.textEl.textContent);
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
    // Park as a margin chip at the drop point, honouring the grab offset so
    // the chip lands exactly where the ghost was (no jump).
    node.where = "margin";
    const p = clientToCanvas(cx, cy);
    node.x = snapMarginX(p.x - a.dragGrab.x);
    node.y = Math.max(8, p.y - a.dragGrab.y);
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
    const node = makeNode("", "margin", snapMarginX(p.x - CHIP_WIDTH / 2), Math.max(8, p.y - 16));
    a.marginNodes.push(node);
    render();
    editNode(node, { clientX: cx, clientY: cy });
  }

  /* ----- ghost ----- */
  function makeGhost(text) {
    const g = el("div", "shuffle-node in-margin shuffle-ghost");
    g.style.width = `${CHIP_WIDTH}px`;
    g.innerHTML = renderShuffleMarkdown(text);
    document.body.appendChild(g);
    return g;
  }
  /** Ghost: below-right of the cursor over the column, grab offset over margins. */
  function positionGhost(cx, cy) {
    const g = a.ghost;
    if (!g) return;
    if (pointInColumn(cx, cy)) {
      g.style.left = `${cx + 14}px`;
      g.style.top = `${cy + 18}px`;
    } else {
      g.style.left = `${cx - a.dragGrab.x}px`;
      g.style.top = `${cy - a.dragGrab.y}px`;
    }
  }

  /** Full-opacity preview of where the dragged sentence drops (column only). */
  function updateDropPreview(cx, cy) {
    if (!pointInColumn(cx, cy)) { removePreview(); return; }
    if (!a.preview) {
      a.preview = el("div", "shuffle-node in-editor shuffle-drop-preview");
      const textEl = el("div", "shuffle-node-text");
      textEl.innerHTML = renderShuffleMarkdown(a.dragText);
      a.preview.appendChild(textEl);
    }
    // Detach first so the index is measured against the real node layout.
    if (a.preview.parentNode) a.preview.remove();
    const idx = editorIndexAt(cy);
    const ref = a.editorNodes[idx]?.el || null;
    if (ref) column.insertBefore(a.preview, ref);
    else column.appendChild(a.preview);
  }
  function removePreview() {
    if (a.preview) { a.preview.remove(); a.preview = null; }
  }
  function removeGhost() { if (a.ghost) { a.ghost.remove(); a.ghost = null; } }

  /* ----- layout ----- */
  function layoutMargins() {
    const cr = canvasRect();
    const colR = column.getBoundingClientRect();
    const colLeft = colR.left - cr.left;
    const colRight = colR.right - cr.left;
    // Centre each side's stack vertically around the editor column.
    const colMidY = (colR.top - cr.top) + colR.height / 2;
    const leftCol = Math.max(8, colLeft - CHIP_WIDTH - MARGIN_GAP);
    const rightCol = clampX(colRight + MARGIN_GAP);
    const leftNodes = [];
    const rightNodes = [];
    a.marginNodes.forEach((n, i) => (i % 2 === 0 ? leftNodes : rightNodes).push(n));
    placeStack(leftNodes, leftCol, colMidY);
    placeStack(rightNodes, rightCol, colMidY);
    growCanvas();
  }

  function placeStack(nodes, x, midY) {
    let total = 0;
    for (const n of nodes) if (n.el) total += n.el.offsetHeight + CHIP_V_GAP;
    total = Math.max(0, total - CHIP_V_GAP);
    let y = Math.max(24, midY - total / 2);
    for (const n of nodes) {
      n.x = x;
      n.y = y;
      if (!n.el) continue;
      n.el.style.left = `${x}px`;
      n.el.style.top = `${y}px`;
      y += n.el.offsetHeight + CHIP_V_GAP;
    }
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

  /* ----- undo / redo (see shuffle-editor-history.js) ----- */
  const { serialize, serializeWithNodeText, pushSnapshot, undo, redo } =
    createShuffleHistory(a, { makeNode, render });

  /** Text written back on accept: struck nodes dropped, surviving column
   *  nodes joined into prose, commented nodes appended in a `%%…%%` block. */
  function buildResult() {
    const main = a.editorNodes
      .filter((n) => !n.strike && !n.comment)
      .map((n) => n.text.trim()).filter(Boolean).join(" ");
    const commented = [...a.editorNodes, ...a.marginNodes]
      .filter((n) => !n.strike && n.comment)
      .map((n) => n.text.trim()).filter(Boolean);
    let out = main;
    if (commented.length) {
      out = (out ? `${out}\n\n` : "") + `%%\n${commented.join("\n")}\n%%`;
    }
    return out;
  }

  /* ----- keyboard-driven ops ----- */

  /** `a` over a hovered node — move it into the column (appended at end). */
  function moveNodeToEditor(node) {
    if (!node || node.where === "editor") return;
    pushSnapshot(serialize());
    a.marginNodes = a.marginNodes.filter((n) => n !== node);
    node.where = "editor";
    a.editorNodes.push(node);
    a.focusNode = node;
    render();
    node.el?.scrollIntoView({ block: "nearest" });
  }

  /** `d` — scatter the node out to a free margin spot, advancing the
   *  selection to the next sentence so repeated presses walk the column. */
  function moveNodeToMargin(node) {
    if (!node || node.where === "margin") return;
    pushSnapshot(serialize());
    const wasFocus = a.focusNode === node;
    const idx = a.editorNodes.indexOf(node);
    a.editorNodes = a.editorNodes.filter((n) => n !== node);
    if (wasFocus) {
      a.focusNode = a.editorNodes[Math.min(idx, a.editorNodes.length - 1)] || null;
    }
    node.where = "margin";
    const spot = freeMarginSpot();
    node.x = clampX(spot.x);
    node.y = Math.max(8, spot.y);
    a.marginNodes.push(node);
    render();
  }

  /** Geometry + existing chip rects → a scattered, non-overlapping spot. */
  function freeMarginSpot() {
    const cr = canvasRect();
    const colR = column.getBoundingClientRect();
    const existing = a.marginNodes.filter((n) => n.el).map((n) => ({
      x: n.x, y: n.y, w: n.el.offsetWidth || CHIP_WIDTH, h: n.el.offsetHeight || 64,
    }));
    return findFreeMarginSpot({
      canvasW: canvas.clientWidth,
      canvasH: Math.max(window.innerHeight, canvas.clientHeight),
      colLeft: colR.left - cr.left, colRight: colR.right - cr.left,
      chipW: CHIP_WIDTH, gap: MARGIN_GAP, existing,
    });
  }

  function applyFocusClass() {
    for (const n of a.editorNodes) n.el?.classList.toggle("focused", n === a.focusNode);
  }

  /** shift+↑/↓ — move the focus to the previous / next column sentence. */
  function moveFocus(dir) {
    const list = a.editorNodes;
    if (!list.length) return;
    let idx = list.indexOf(a.focusNode);
    if (idx === -1) idx = dir > 0 ? -1 : list.length;
    idx = Math.max(0, Math.min(list.length - 1, idx + dir));
    a.focusNode = list[idx];
    applyFocusClass();
    a.focusNode.el?.scrollIntoView({ block: "nearest" });
  }

  /** cmd+↑/↓ — shift the focused sentence up / down one slot. */
  function shiftFocusedSentence(dir) {
    const list = a.editorNodes;
    const i = list.indexOf(a.focusNode);
    if (i === -1) return;
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    pushSnapshot(serialize());
    [list[i], list[j]] = [list[j], list[i]];
    render();
    a.focusNode.el?.scrollIntoView({ block: "nearest" });
  }

  /** Arrow nav. Works mid-edit: commit the edited node, treat it as focus,
   *  run the op (cmd = reorder, shift = move focus), then re-enter edit. */
  function arrowNav(dir, meta) {
    const wasEditing = !!a.editingNode;
    if (a.editingNode) {
      const ed = a.editingNode;
      commitEdit(ed);
      if (a.editorNodes.includes(ed)) a.focusNode = ed;
    }
    if (!a.focusNode) a.focusNode = a.editorNodes[0] || null;
    if (!a.focusNode) return;
    if (meta) shiftFocusedSentence(dir);
    else moveFocus(dir);
    if (wasEditing && a.focusNode) reEditAtEnd(a.focusNode);
  }

  const ctrl = {
    render, layoutMargins, reflowOnResize, shuffleMargins, undo, redo,
    createEditorNodeAt, createMarginNodeAt, buildResult,
    moveNodeToEditor, moveNodeToMargin, toggleNodeFlag: toggleFlag, arrowNav,
  };
  return ctrl;
}

/* ===== Close / compare ===== */

function beginClose() {
  if (!active || active.compare) return;
  showCompare(active.payload.text, active.ctrl.buildResult());
}

function showCompare(originalText, newText) {
  active.compare = buildCompareModal(originalText, newText, {
    onCancel: () => dismissCompare(),
    onKeepOriginal: () => finalize(null),
    onKeepShuffled: () => finalize(newText),
  });
  active.overlay.appendChild(active.compare);
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
  if (typeof content === "string") writeBackShuffle(payload, content);
  state.toggleShuffleEditor(); // tears the overlay down via the listener
}

/* ===== Small DOM helpers ===== */

function el(tag, className) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

