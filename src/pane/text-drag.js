/**
 * Cmd-drag text between docs/panes and notebooks.
 *
 * Source: a CodeMirror editor's current selection (main or pane) or one or
 * more text shapes in a notebook. On pointerup over any CodeMirror editor
 * the payload is inserted as plain text at the drop coordinate (multi-
 * shape payloads are joined in shelf order — top-to-bottom, left-to-right
 * — with blank lines between). Over a registered notebook canvas a
 * multi-shape payload lands as separate text shapes whose relative
 * positions are preserved, anchored at the drop point. Holding Shift at
 * drop deletes the source.
 */
import { EditorView } from "@codemirror/view";
import { isCmdHeld } from "../cmd-button.js";

let active = null;

// Notebook canvases registered as drop targets.
const notebookTargets = new Set();

/**
 * Register a notebook canvas as a drop target. Returns an unregister fn.
 * @param {HTMLCanvasElement} canvasEl
 * @param {object} state The notebook's DrawingState
 */
export function registerNotebookDropTarget(canvasEl, state) {
  const entry = { canvasEl, state };
  notebookTargets.add(entry);
  return () => { notebookTargets.delete(entry); };
}

/**
 * Start a custom text-drag session.
 *
 * @param {object} opts
 * @param {string}   [opts.text]          Plain text payload (editor selection or a single shape).
 * @param {Array}    [opts.shapes]        Notebook shapes payload. Each entry keeps its
 *                                        own { text, position, width, fontSize, color,
 *                                        backgroundColor } so relative positions survive
 *                                        a notebook-to-notebook drop.
 * @param {string}   [opts.anchorId]      The shape id under the cursor at drag start — used
 *                                        as the origin when replaying relative positions.
 * @param {PointerEvent} opts.initialEvent
 * @param {(deleteSource: boolean) => void} [opts.onDrop]
 *   Called after a successful drop, with `true` when the source should be
 *   removed (Shift was held at pointerup).
 */
export function startTextDrag({ text, shapes, anchorId, image, editorText, initialEvent, onDrop }) {
  // Normalise: derive the text payload from shapes when needed, ordered
  // top-to-bottom / left-to-right so CM drops land in reading order.
  const hasShapes = Array.isArray(shapes) && shapes.length > 0;
  const fallbackText = image && !text ? `![${image.name || "image"}](${image.name || "image"})` : (text || "");
  const joined = hasShapes ? joinShapesForText(shapes) : fallbackText;
  // `editorText` (when set) overrides the joined payload for drops into
  // a CodeMirror editor — used by the flowchart-aware drag to surface
  // the dragged subtree as a nested markdown list. Notebook-side drops
  // still consume the original `shapes` verbatim, so the notebook
  // round-trip isn't affected.
  const editorPayload = editorText || joined;
  if (active) return;
  if (!joined && !image) return;

  // Inactive panes disable pointer-events on their content (see
  // floating-pane.css), which would also hide them from elementFromPoint
  // during the drop search. Add a body class for the duration of the
  // drag so the CSS override re-enables pointer-events.
  document.body.classList.add("text-drag-active");

  // Ghost follows the cursor. Parent is <html> so we're above anything
  // the app might stack inside body (floating panes live at z-index 90
  // but nested stacking contexts can still mask a body-level child).
  const ghost = document.createElement("div");
  ghost.className = "text-drag-ghost";
  if (image && image.dataUrl) {
    ghost.classList.add("text-drag-ghost-image");
    const img = document.createElement("img");
    img.src = image.dataUrl;
    ghost.appendChild(img);
  } else {
    ghost.textContent = ghostPreview(hasShapes ? shapes : null, joined);
  }
  ghost.style.left = initialEvent.clientX + 12 + "px";
  ghost.style.top = initialEvent.clientY + 12 + "px";
  document.documentElement.appendChild(ghost);

  let shiftHeld = !!initialEvent.shiftKey;
  updateGhostMode(ghost, shiftHeld);

  const startX = initialEvent.clientX;
  const startY = initialEvent.clientY;
  const MOVE_THRESHOLD = 4;
  let moved = false;
  let hoveredPane = null;

  function setHoveredPane(paneEl) {
    if (paneEl === hoveredPane) return;
    if (hoveredPane) hoveredPane.classList.remove("pane-drop-target");
    hoveredPane = paneEl;
    if (hoveredPane) hoveredPane.classList.add("pane-drop-target");
  }

  function onMove(e) {
    if (!moved) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (dx * dx + dy * dy >= MOVE_THRESHOLD * MOVE_THRESHOLD) moved = true;
    }
    ghost.style.left = e.clientX + 12 + "px";
    ghost.style.top = e.clientY + 12 + "px";
    if (e.shiftKey !== shiftHeld) {
      shiftHeld = e.shiftKey;
      updateGhostMode(ghost, shiftHeld);
    }
    // Highlight the pane currently under the cursor (if any).
    const target = findDropTarget(e.clientX, e.clientY);
    const targetEl = target && targetElementOf(target);
    setHoveredPane(targetEl ? targetEl.closest(".floating-pane") : null);
  }

  function onKey(e) {
    if (e.shiftKey !== shiftHeld) {
      shiftHeld = e.shiftKey;
      updateGhostMode(ghost, shiftHeld);
    }
  }

  function cleanup() {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    ghost.remove();
    setHoveredPane(null);
    document.body.classList.remove("text-drag-active");
    active = null;
  }

  function onUp(e) {
    const deleteSource = shiftHeld || e.shiftKey;
    // Resolve the drop target BEFORE cleanup, since cleanup removes the
    // body.text-drag-active class that re-enables pointer-events on
    // inactive panes. Without this order elementFromPoint would return
    // something behind the pane and the drop would silently no-op.
    const target = moved ? findDropTarget(e.clientX, e.clientY) : null;
    cleanup();
    if (!target) { if (onDrop) onDrop(false); return; }

    // If the drop landed inside a floating pane, activate that pane first
    // so its editor becomes editable and focused. The pane's own
    // pointerdown handler wires focusPane() via this synthetic event.
    focusPaneIfInside(targetElementOf(target));
    // Routing — keep sync paths sync; async paths fire-and-forget.
    if (target.kind === "cm") {
      if (image) {
        insertImageIntoEditor(target.view, image, e.clientX, e.clientY);
      } else {
        insertIntoEditor(target.view, editorPayload, e.clientX, e.clientY);
      }
    } else if (target.kind === "nb") {
      if (image) {
        insertImageIntoNotebook(target.state, target.canvasEl, image, e.clientX, e.clientY);
      } else if (hasShapes) {
        insertShapesIntoNotebook(target.state, target.canvasEl, shapes, anchorId, e.clientX, e.clientY);
      } else if (isSingleImageRef(joined)) {
        insertImageRefIntoNotebook(target.state, target.canvasEl, joined, e.clientX, e.clientY);
      } else {
        insertTextIntoNotebook(target.state, target.canvasEl, joined, e.clientX, e.clientY);
      }
    }
    if (onDrop) onDrop(deleteSource);
  }

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);
  active = { ghost, cleanup };
}

export function isTextDragging() {
  return active !== null;
}

/**
 * Wire a notebook canvas as a cmd-drag source. A cmd-mousedown on a text
 * shape starts a drag with that shape's text; if multiple text shapes are
 * selected and the click lands on one of them, the whole selection is
 * carried (with relative positions preserved for notebook drops). Shift
 * at drop deletes the source shape(s).
 *
 * @param {HTMLCanvasElement} canvasEl
 * @param {HTMLElement} containerEl Ancestor of canvasEl.
 * @param {object} state   DrawingState from notes-canvas.
 * @param {object} helpers { findTextShapeAt, hitTestLink? }
 * @param {() => void} [markDirty]
 * @returns {() => void} unregister
 */
export function attachNotebookTextShapeDrag(canvasEl, containerEl, state, helpers, markDirty) {
  const handler = (e) => {
    if (!isCmdHeld(e)) return;
    if (e.button !== 0) return;
    if (!(e.target instanceof Node) || !canvasEl.contains(e.target)) return;
    const rect = canvasEl.getBoundingClientRect();
    const canvasPt = {
      x: (e.clientX - rect.left - state.camera.x) / state.camera.zoom,
      y: (e.clientY - rect.top - state.camera.y) / state.camera.zoom,
    };
    const hit = helpers.findTextShapeAt(state.shapes, canvasPt);
    if (!hit) return;
    if (helpers.hitTestLink && helpers.hitTestLink(canvasPt, hit)) return;

    // Expand to the current selection when the click lands on a selected
    // shape and more than one text shape is selected. Otherwise drag just
    // the hit shape.
    const selected = state.selectedIds instanceof Set
      ? state.shapes.filter((s) => state.selectedIds.has(s.id) && s.type === "text")
      : [];
    const shapes = (selected.length > 1 && selected.some((s) => s.id === hit.id))
      ? selected.map(cloneShapePayload)
      : [cloneShapePayload(hit)];

    // Flowchart-aware editor payload — when any dragged shape is part
    // of a flowchart (has children or a parent), expand the set to
    // include every descendant and render it as a nested markdown
    // list. Notebook-side drops still consume the original `shapes`
    // verbatim, so the same drag carries both forms — outline for
    // editors, flat shapes for canvases.
    let editorText;
    const flow = state.flowchart;
    if (flow) {
      const touchesFlow = shapes.some((s) =>
        flow.childrenOf(s.id).length > 0 || flow.parentOf(s.id) != null
      );
      if (touchesFlow) {
        const allIds = new Set(shapes.map((s) => s.id));
        const queue = [...allIds];
        while (queue.length > 0) {
          const cur = queue.pop();
          for (const c of flow.childrenOf(cur)) {
            if (!allIds.has(c)) { allIds.add(c); queue.push(c); }
          }
        }
        const expanded = state.shapes
          .filter((s) => s.type === "text" && allIds.has(s.id))
          .map(cloneShapePayload);
        editorText = buildFlowchartOutline(expanded, flow.edges || [], hit.id);
      }
    }

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    startTextDrag({
      shapes,
      anchorId: hit.id,
      editorText,
      initialEvent: e,
      onDrop: (deleteSource) => {
        if (!deleteSource) return;
        const ids = new Set(shapes.map((s) => s.id));
        state.shapes = state.shapes.filter((s) => !ids.has(s.id));
        state.selectedIds = new Set();
        state.notify("shapes");
        state.notify("selectedIds");
        state.recordHistory();
        if (markDirty) markDirty();
      },
    });
  };
  containerEl.addEventListener("pointerdown", handler, true);
  return () => containerEl.removeEventListener("pointerdown", handler, true);
}

/**
 * Wire a CodeMirror editor as a cmd-drag source.
 *
 * Listens on `containerEl` in the capture phase so the handler runs
 * before CodeMirror's own pointerdown on contentDOM (listeners on the
 * target element fire in registration order regardless of phase, so we
 * need an ancestor to win the race).
 *
 * @param {EditorView} view       The CodeMirror view whose selection seeds the drag.
 * @param {HTMLElement} containerEl An ancestor of view.contentDOM.
 * @returns {() => void} unregister
 */
export function attachEditorTextDrag(view, containerEl) {
  const handler = (e) => {
    if (!isCmdHeld(e)) return;
    if (e.button !== 0) return;
    if (!(e.target instanceof Node) || !view.contentDOM.contains(e.target)) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    // Only trigger if pointerdown lands on (or inside) the selection range.
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null || pos < sel.from || pos > sel.to) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const text = view.state.sliceDoc(sel.from, sel.to);
    const from = sel.from;
    const to = sel.to;
    startTextDrag({
      text,
      initialEvent: e,
      onDrop: (deleteSource) => {
        if (deleteSource) {
          view.dispatch({ changes: { from, to, insert: "" } });
        }
      },
    });
  };
  containerEl.addEventListener("pointerdown", handler, true);
  return () => containerEl.removeEventListener("pointerdown", handler, true);
}

function updateGhostMode(ghost, deleteOnDrop) {
  ghost.classList.toggle("text-drag-ghost-move", deleteOnDrop);
}

function ghostPreview(shapes, joined) {
  if (shapes && shapes.length > 1) return `${shapes.length} items`;
  const s = joined || "";
  return s.length > 80 ? s.slice(0, 77) + "\u2026" : s;
}

function cloneShapePayload(s) {
  return {
    id: s.id,
    text: s.text,
    position: { x: s.position.x, y: s.position.y },
    width: s.width,
    fontSize: s.fontSize,
    color: s.color,
    backgroundColor: s.backgroundColor,
  };
}

/** Render `shapes` as a nested markdown list, using `edges` to nest
 *  children under their parents. Roots = shapes whose parent isn't in
 *  the supplied set; siblings are ordered positionally; multi-line
 *  shape text hangs continuation lines under the bullet. Used when a
 *  Cmd-drag from the notebook touches a flowchart node so the doc
 *  receives the subtree as an outline rather than concatenated text. */
function buildFlowchartOutline(shapes, edges, anchorId) {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const ids = new Set(shapes.map((s) => s.id));
  const parentOfMap = new Map();
  for (const e of edges) parentOfMap.set(e.to, e.from);

  const roots = shapes.filter((s) => {
    const p = parentOfMap.get(s.id);
    return !p || !ids.has(p);
  });
  roots.sort((a, b) => {
    if (a.id === anchorId) return -1;
    if (b.id === anchorId) return 1;
    return (a.position.y - b.position.y) || (a.position.x - b.position.x);
  });

  const lines = [];
  function walk(id, depth) {
    const sh = byId.get(id);
    if (!sh) return;
    const indent = "  ".repeat(depth);
    const text = (sh.text || "").trim();
    const tLines = text ? text.split("\n") : [""];
    lines.push(`${indent}- ${tLines[0]}`);
    for (let i = 1; i < tLines.length; i++) lines.push(`${indent}  ${tLines[i]}`);
    const childIds = edges.filter((e) => e.from === id).map((e) => e.to).filter((c) => ids.has(c));
    childIds.sort((a, b) => {
      const sa = byId.get(a);
      const sb = byId.get(b);
      if (!sa || !sb) return 0;
      return (sa.position.y - sb.position.y) || (sa.position.x - sb.position.x);
    });
    for (const c of childIds) walk(c, depth + 1);
  }
  for (const r of roots) walk(r.id, 0);
  return lines.join("\n");
}

/** Sort shapes top-to-bottom / left-to-right and join their text. */
function joinShapesForText(shapes) {
  const sorted = [...shapes].sort((a, b) =>
    (a.position.y - b.position.y) || (a.position.x - b.position.x)
  );
  return sorted.map((s) => s.text || "").filter(Boolean).join("\n\n");
}

function targetElementOf(target) {
  if (!target) return null;
  if (target.kind === "nb") return target.canvasEl;
  if (target.kind === "cm") return target.view.dom;
  return null;
}

function findDropTarget(x, y) {
  // Walk the whole stack at the drop point, not just the topmost element.
  // The ghost (though pointer-events:none) and other siblings can still
  // show up here, so we look for the first element that matches a known
  // drop target type.
  const stack = document.elementsFromPoint(x, y);
  for (const el of stack) {
    if (!(el instanceof Element)) continue;

    // Notebook canvas targets — matched by direct element identity so we
    // don't accidentally catch unrelated canvases.
    for (const entry of notebookTargets) {
      if (entry.canvasEl === el || entry.canvasEl.contains(el)) {
        return { kind: "nb", canvasEl: entry.canvasEl, state: entry.state };
      }
    }

    const cm = el.closest(".cm-editor");
    if (cm) {
      const view = EditorView.findFromDOM(cm);
      if (view) return { kind: "cm", view };
    }
  }
  return null;
}

function insertIntoEditor(view, text, x, y) {
  // Prefer the coordinate directly under the cursor; fall back to the
  // current selection's head if the point lies between lines.
  let pos = view.posAtCoords({ x, y });
  if (pos == null) pos = view.posAtCoords({ x, y }, false);
  if (pos == null) pos = view.state.selection.main.head;
  view.dispatch({
    changes: { from: pos, to: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
  view.focus();
}

function screenToCanvasPt(state, canvasEl, clientX, clientY) {
  const rect = canvasEl.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.camera.x) / state.camera.zoom,
    y: (clientY - rect.top - state.camera.y) / state.camera.zoom,
  };
}

function insertTextIntoNotebook(state, canvasEl, text, clientX, clientY) {
  if (typeof state.addTextShapeAtPosition !== "function") return;
  state.addTextShapeAtPosition(text, screenToCanvasPt(state, canvasEl, clientX, clientY));
}

function insertShapesIntoNotebook(state, canvasEl, shapes, anchorId, clientX, clientY) {
  const dropPt = screenToCanvasPt(state, canvasEl, clientX, clientY);
  const anchor = shapes.find((s) => s.id === anchorId) || shapes[0];
  // Each shape lands at drop + (shape.position - anchor.position) so the
  // shape the user grabbed arrives under the cursor and the rest keeps
  // its layout relative to it. We mutate state.shapes directly to
  // preserve fontSize/width/colour fidelity (the public helper would
  // coerce to defaults).
  const newShapes = shapes.map((s) => ({
    id: generateShapeId(),
    type: "text",
    position: {
      x: dropPt.x + (s.position.x - anchor.position.x),
      y: dropPt.y + (s.position.y - anchor.position.y),
    },
    text: s.text || "",
    fontSize: s.fontSize != null ? s.fontSize : 18,
    color: s.color || "#000000",
    width: s.width,
    ...(s.backgroundColor ? { backgroundColor: s.backgroundColor } : {}),
  }));
  state.shapes = [...state.shapes, ...newShapes];
  state.selectedIds = new Set(newShapes.map((s) => s.id));
  if (typeof state.recordHistory === "function") state.recordHistory();
  state.notify("shapes");
  state.notify("selectedIds");
}

function generateShapeId() {
  // Mirror notebook/utils.ts generateId — millisecond ts plus randomness
  // is enough; collisions across independent canvases are inconsequential.
  return Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}

const IMAGE_REF_RE = /^!\[[^\]]*\]\(\s*(?:"[^"]+"|[^()\s"]+)(?:\s+"[^"]*")?\s*\)$/;

function isSingleImageRef(text) {
  return typeof text === "string" && IMAGE_REF_RE.test(text.trim());
}

function parseImageMarkdown(text) {
  const m = text.trim().match(/^!\[([^\]]*)\]\(\s*(?:"([^"]+)"|([^()\s"]+))(?:\s+"[^"]*")?\s*\)$/);
  if (!m) return null;
  const url = m[2] != null ? m[2] : m[3];
  return { rawAlt: m[1], url, filename: url.replace(/^images\//, "") };
}

/** Doc → Notebook: resolve the referenced image and drop it as an ImageShape. */
async function insertImageRefIntoNotebook(state, canvasEl, text, clientX, clientY) {
  const parsed = parseImageMarkdown(text);
  if (!parsed) return;
  try {
    const { getImageDataUrl } = await import("../state/state-images.js");
    const dataUrl = await getImageDataUrl(parsed.filename);
    if (!dataUrl) {
      state.addTextShapeAtPosition(text, screenToCanvasPt(state, canvasEl, clientX, clientY));
      return;
    }
    const dims = await loadImageDimensions(dataUrl);
    const pos = screenToCanvasPt(state, canvasEl, clientX, clientY);
    if (typeof state.addImageShape === "function") {
      state.addImageShape(dataUrl, parsed.filename, dims.width, dims.height, pos);
    }
  } catch (_) { /* ignore — leave the canvas untouched on failure */ }
}

/** Notebook → Doc: save the shape's image to the Images folder, insert markdown. */
async function insertImageIntoEditor(view, image, clientX, clientY) {
  if (!image || !image.dataUrl) return;
  try {
    const state = await getAppState();
    if (!state) return;
    const res = await saveDataUrlAsImageNode(state, image.name, image.dataUrl);
    if (!res) return;
    const { buildImageMarkdown } = await import("../state/state-images.js");
    const md = buildImageMarkdown(res.alt || image.name || "image", res.filename);
    let pos = view.posAtCoords({ x: clientX, y: clientY });
    if (pos == null) pos = view.posAtCoords({ x: clientX, y: clientY }, false);
    if (pos == null) pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const prefix = pos === line.from ? "" : "\n";
    const suffix = pos === line.to ? "\n" : "\n";
    const insert = prefix + md + suffix;
    view.dispatch({
      changes: { from: pos, to: pos, insert },
      selection: { anchor: pos + insert.length },
    });
    view.focus();
    state.markDirty();
  } catch (e) { console.error("Image drop into editor failed:", e); }
}

/** Notebook → Notebook: add the image as a new ImageShape at the drop point. */
function insertImageIntoNotebook(state, canvasEl, image, clientX, clientY) {
  if (!image || !image.dataUrl || typeof state.addImageShape !== "function") return;
  const pos = screenToCanvasPt(state, canvasEl, clientX, clientY);
  const w = image.width > 0 ? image.width : 400;
  const h = image.height > 0 ? image.height : 400;
  state.addImageShape(image.dataUrl, image.name || "image", w, h, pos);
}

/**
 * Sidebar → Editor/Notebook: drop an Images-folder entry directly at the
 * pointer location. Resolves the target from `elementsFromPoint`, so it
 * works for the main editor, doc panes, the main notebook, and notebook
 * panes without wiring extra listeners.
 */
export async function dropSidebarImageAt(filename, clientX, clientY) {
  if (!filename) return;
  const target = findDropTarget(clientX, clientY);
  if (!target) return;
  focusPaneIfInside(targetElementOf(target));
  const { getImageDataUrl, buildImageMarkdown } = await import("../state/state-images.js");
  const dataUrl = await getImageDataUrl(filename);
  if (!dataUrl) return;
  if (target.kind === "cm") {
    const alt = filename.replace(/\.[^.]+$/, "") || "image";
    const md = buildImageMarkdown(alt, filename);
    insertImageMarkdownAt(target.view, md, clientX, clientY);
    const state = await getAppState();
    if (state) state.markDirty();
  } else if (target.kind === "nb") {
    const dims = await loadImageDimensions(dataUrl);
    insertImageIntoNotebook(
      target.state, target.canvasEl,
      { dataUrl, name: filename, width: dims.width, height: dims.height },
      clientX, clientY,
    );
  }
}

function insertImageMarkdownAt(view, md, clientX, clientY) {
  let pos = view.posAtCoords({ x: clientX, y: clientY });
  if (pos == null) pos = view.posAtCoords({ x: clientX, y: clientY }, false);
  if (pos == null) pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const prefix = pos === line.from ? "" : "\n";
  const suffix = pos === line.to ? "\n" : "\n";
  const insert = prefix + md + suffix;
  view.dispatch({
    changes: { from: pos, to: pos, insert },
    selection: { anchor: pos + insert.length },
  });
  view.focus();
}

function loadImageDimensions(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 400, height: img.naturalHeight || 400 });
    img.onerror = () => resolve({ width: 400, height: 400 });
    img.src = dataUrl;
  });
}

async function getAppState() {
  // The main-process AppState instance is exposed on window by main.js.
  // If it isn't there (first seconds of startup), bail out.
  return typeof window !== "undefined" ? window.__hushState__ || null : null;
}

async function saveDataUrlAsImageNode(state, rawName, dataUrl) {
  const { AppState } = await import("../state/state.js");
  const { findNode } = await import("../state/tree-helpers.js");
  const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;
  const baseName = (rawName || "image").replace(/^.*[\\/]/, "") || "image";
  let finalName = baseName;
  if (IS_TAURI) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const saved = await invoke("save_image", { filename: baseName, dataUrl });
      finalName = saved.filename;
    } catch (e) { console.error("save_image failed:", e); return null; }
  }
  const images = findNode(state.fileTree, state.getImagesId());
  if (images) {
    const already = (images.children || []).some((c) => c.type === "image" && c.fileId === finalName);
    if (!already) {
      (images.children || (images.children = [])).push({
        id: crypto.randomUUID(),
        type: "image",
        name: finalName,
        fileId: finalName,
        children: [],
        flagged: false,
      });
      await state.saveFileTree();
      state.emit("files-changed");
    }
  }
  const { clearImageCache } = await import("../state/state-images.js");
  clearImageCache(finalName);
  return { filename: finalName, alt: finalName.replace(/\.[^.]+$/, "") };
}

/**
 * Wire a notebook canvas as a source for Cmd+drag of image shapes.
 * Returns an unregister function.
 */
export function attachNotebookImageShapeDrag(canvasEl, containerEl, state, helpers, markDirty) {
  const handler = (e) => {
    if (!isCmdHeld(e)) return;
    if (e.button !== 0) return;
    if (!(e.target instanceof Node) || !canvasEl.contains(e.target)) return;
    const rect = canvasEl.getBoundingClientRect();
    const canvasPt = {
      x: (e.clientX - rect.left - state.camera.x) / state.camera.zoom,
      y: (e.clientY - rect.top - state.camera.y) / state.camera.zoom,
    };
    const hit = helpers.findImageShapeAt(state.shapes, canvasPt);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    startTextDrag({
      image: {
        dataUrl: hit.dataUrl,
        name: hit.name || "image",
        width: hit.width,
        height: hit.height,
      },
      initialEvent: e,
      onDrop: (deleteSource) => {
        if (!deleteSource) return;
        state.shapes = state.shapes.filter((s) => s.id !== hit.id);
        state.selectedIds = new Set();
        state.notify("shapes");
        state.notify("selectedIds");
        state.recordHistory();
        if (markDirty) markDirty();
      },
    });
  };
  containerEl.addEventListener("pointerdown", handler, true);
  return () => containerEl.removeEventListener("pointerdown", handler, true);
}

/** If `el` lives inside a .floating-pane, trigger its pane's focus logic
 *  so the drop target becomes the active pane (editable + focused). */
function focusPaneIfInside(el) {
  if (!(el instanceof Element)) return;
  const paneEl = el.closest(".floating-pane");
  if (!paneEl) return;
  paneEl.dispatchEvent(new PointerEvent("pointerdown", {
    bubbles: true, cancelable: true, pointerType: "mouse",
  }));
}
