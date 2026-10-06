/**
 * Footnotes — CodeMirror ViewPlugin that decorates [^id] references with
 * clickable colored dots (or underlines for text IDs) and shows footnote
 * definitions as overlays or marginalia depending on margin width.
 */
import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import {
  isEditing, closeOverlay, getActiveOverlay,
  getFootnoteSettings, resolveFootnoteFont, getThemeColors,
  createEditableContent, showOverlayAt, openFootnoteOverlayByPos,
  updateMarginalia, debouncedUpdateMarginalia, clearMarginalia,
  setupFootnoteHandlers, setFindDefRange, setDropIndicatorFns,
} from "./footnotes-ui.js";

const FOOTNOTE_REF_RE = /\[\^([^\]]+)\]/g;
const FOOTNOTE_DEF_RE = /^\[\^([^\]]+)\]:\s*(.*)/;

const DOT_COLORS = [
  "#e6a23c", "#409eff", "#f56c6c", "#67c23a", "#9b59b6",
  "#e67e22", "#3498db", "#e74c3c", "#2ecc71", "#e91e63",
];

let colorIndex = 0;
const colorMap = new Map();

function getColorForId(id) {
  if (!colorMap.has(id)) {
    colorMap.set(id, DOT_COLORS[colorIndex % DOT_COLORS.length]);
    colorIndex++;
  }
  return colorMap.get(id);
}

function isNumericId(id) { return /^\d+$/.test(id); }

const MARGIN_THRESHOLD = 200;

/** The text column's side margins in `view` (the scroller's inline
 *  padding, which modes.js writes for the main editor). Measured on the
 *  view itself: the plugin runs in panes, stack columns and cards too, and
 *  reading the main editor's padding for those drew marginalia into
 *  surfaces with no room for them. */
function getMargins(view) {
  const scroller = view?.scrollDOM;
  if (!scroller) return { left: 0, right: 0 };
  return {
    left: parseInt(scroller.style.paddingLeft) || 50,
    right: parseInt(scroller.style.paddingRight) || 50,
  };
}

function isWideMargin(view) {
  const m = getMargins(view);
  return m.left >= MARGIN_THRESHOLD && m.right >= MARGIN_THRESHOLD;
}

// Drop zone indicator for footnote dragging
let _dropIndicator = null;

function showDropIndicator(view, x, y) {
  const pos = view.posAtCoords({ x, y });
  if (pos == null) { hideDropIndicator(); return; }
  const coords = view.coordsAtPos(pos);
  if (!coords) { hideDropIndicator(); return; }
  if (!_dropIndicator) {
    _dropIndicator = document.createElement("div");
    _dropIndicator.className = "footnote-drop-indicator";
    document.body.appendChild(_dropIndicator);
  }
  _dropIndicator.style.left = coords.left + "px";
  _dropIndicator.style.top = coords.top + "px";
  _dropIndicator.style.height = (coords.bottom - coords.top) + "px";
}

function hideDropIndicator() {
  if (_dropIndicator) { _dropIndicator.remove(); _dropIndicator = null; }
}

function parseDefinitions(doc) {
  const defs = new Map();
  const lines = doc.toString().split("\n");
  let currentId = null, currentText = "";

  for (const line of lines) {
    const match = line.match(FOOTNOTE_DEF_RE);
    if (match) {
      if (currentId !== null) defs.set(currentId, currentText.trim());
      currentId = match[1];
      currentText = match[2];
    } else if (currentId !== null && /^  /.test(line)) {
      currentText += " " + line.trim();
    } else {
      if (currentId !== null) { defs.set(currentId, currentText.trim()); currentId = null; currentText = ""; }
    }
  }
  if (currentId !== null) defs.set(currentId, currentText.trim());
  return defs;
}

function findDefinitionRange(doc, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\[\\^${escapedId}\\]:\\s*`);
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = line.text.match(re);
    if (m) {
      const textFrom = line.from + m[0].length;
      let textTo = line.to;
      for (let j = i + 1; j <= doc.lines; j++) {
        const nl = doc.line(j);
        if (/^  /.test(nl.text)) textTo = nl.to; else break;
      }
      return { from: textFrom, to: textTo };
    }
  }
  return null;
}

// Provide findDefinitionRange to the UI module
setFindDefRange(findDefinitionRange);

// Deps object shared with UI functions
const uiDeps = { FOOTNOTE_REF_RE, FOOTNOTE_DEF_RE, parseDefinitions, getColorForId, isWideMargin };

// Module-level stateRef — set when the plugin is created
let _stateRef = null;

function getFootnoteRefAtCursor(state) {
  const cursorPos = state.selection.main.head;
  for (let i = 1; i <= state.doc.lines; i++) {
    const line = state.doc.line(i);
    if (line.from > cursorPos) break;
    if (line.to < cursorPos) continue;
    if (FOOTNOTE_DEF_RE.test(line.text)) continue;
    FOOTNOTE_REF_RE.lastIndex = 0;
    let m;
    while ((m = FOOTNOTE_REF_RE.exec(line.text)) !== null) {
      const from = line.from + m.index;
      const to = from + m[0].length;
      if (cursorPos >= from && cursorPos <= to) return { id: m[1], from, to };
    }
  }
  return null;
}

class FootnoteDotWidget extends WidgetType {
  constructor(id, defText, color, from, to, stateRef) {
    super();
    this.id = id; this.defText = defText; this.color = color;
    this.from = from; this.to = to; this.stateRef = stateRef;
    const fs = getFootnoteSettings(stateRef);
    this.useColors = fs.useColors; this.fontFamily = fs.fontFamily; this.fontSizePct = fs.fontSize;
  }

  eq(other) {
    return this.id === other.id && this.defText === other.defText &&
           this.color === other.color && this.useColors === other.useColors &&
           this.fontFamily === other.fontFamily && this.fontSizePct === other.fontSizePct;
  }

  toDOM(view) {
    const fsettings = getFootnoteSettings(this.stateRef);
    const dot = document.createElement("span");
    dot.className = "footnote-dot";
    dot.textContent = this.id;
    dot.dataset.footnoteId = this.id;
    dot.title = this.defText || `Footnote ${this.id}`;
    dot.style.fontFamily = resolveFootnoteFont(fsettings.fontFamily);
    dot.style.fontSize = (9 * fsettings.fontSize / 100) + "px";

    if (fsettings.useColors) { dot.style.backgroundColor = this.color; dot.style.color = "#fff"; }
    else { const c = getThemeColors(); dot.style.backgroundColor = c.fg; dot.style.color = c.bg; }

    const self = this;
    let dragStartX, dragStartY, isDragging = false, ghost = null;

    dot.addEventListener("mousedown", (e) => {
      e.preventDefault(); e.stopPropagation();
      dragStartX = e.clientX; dragStartY = e.clientY; isDragging = false;

      function onMove(e2) {
        if (!isDragging && Math.abs(e2.clientX - dragStartX) + Math.abs(e2.clientY - dragStartY) > 6) {
          isDragging = true; closeOverlay();
          ghost = dot.cloneNode(true);
          ghost.className = "footnote-dot footnote-drag-ghost";
          ghost.style.cssText = "position:fixed;pointer-events:none;opacity:0.7;z-index:10000;transform:scale(1.3);";
          document.body.appendChild(ghost);
        }
        if (ghost) {
          ghost.style.left = (e2.clientX - 8) + "px";
          ghost.style.top = (e2.clientY - 8) + "px";
          showDropIndicator(view, e2.clientX, e2.clientY);
        }
      }
      function onUp(e2) {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (ghost) { ghost.remove(); ghost = null; }
        hideDropIndicator();
        if (isDragging) {
          const dropPos = view.posAtCoords({ x: e2.clientX, y: e2.clientY });
          if (dropPos != null && self.from != null) {
            const refText = `[^${self.id}]`;
            let insertAt = dropPos;
            if (insertAt > self.from) insertAt -= (self.to - self.from);
            view.dispatch({ changes: [{ from: self.from, to: self.to }, { from: insertAt, insert: refText }] });
          }
        } else {
          const ao = getActiveOverlay();
          if (ao && ao.dataset.footnoteId === self.id) { closeOverlay(); return; }
          closeOverlay();
          self._showOverlay(dot, view);
        }
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });

    return dot;
  }

  _showOverlay(dot, view) {
    closeOverlay();
    showOverlayAt(dot, this.id, view, this.stateRef, uiDeps);
  }

  ignoreEvent() { return true; }
}

function buildDecorations(view, stateRef) {
  if (stateRef.privateMode) return Decoration.none;
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  const defs = parseDefinitions(doc);
  const fsettings = getFootnoteSettings(stateRef);
  const cursors = view.state.selection.ranges.map(r => ({ from: r.from, to: r.to }));

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (FOOTNOTE_DEF_RE.test(line.text)) continue;
    FOOTNOTE_REF_RE.lastIndex = 0;
    let match;
    while ((match = FOOTNOTE_REF_RE.exec(line.text)) !== null) {
      const id = match[1];
      const from = line.from + match.index;
      const to = from + match[0].length;
      const defText = defs.get(id) || "";
      const color = getColorForId(id);
      if (cursors.some(c => (c.from >= from && c.from <= to) || (c.to >= from && c.to <= to))) continue;

      if (isNumericId(id)) {
        builder.add(from, to, Decoration.replace({
          widget: new FootnoteDotWidget(id, defText, color, from, to, stateRef),
        }));
      } else {
        const uColor = fsettings.useColors ? color : getThemeColors().fg;
        builder.add(from, to, Decoration.mark({
          class: "footnote-underline",
          attributes: {
            style: `border-bottom: 2px solid ${uColor};`,
            "data-footnote-id": id,
            title: defText || `Footnote: ${id}`,
          },
        }));
      }
    }
  }
  return builder.finish();
}

export { showDropIndicator, hideDropIndicator };

export function insertFootnote(view) {
  const state = view.state;
  const sel = state.selection.main;

  // Case 1: overlay is open → save and close it
  if (getActiveOverlay()) {
    closeOverlay();
    view.focus();
    return true;
  }

  // Case 2: cursor is inside a footnote ref (no selection) → open its overlay
  if (sel.empty) {
    const ref = getFootnoteRefAtCursor(state);
    if (ref) {
      openFootnoteOverlayByPos(ref.from, ref.id, view, _stateRef, uiDeps);
      return true;
    }
  }

  // Find next available numeric id for cases 3 & 4
  const docText = state.doc.toString();
  let maxNum = 0;
  FOOTNOTE_REF_RE.lastIndex = 0;
  let m;
  while ((m = FOOTNOTE_REF_RE.exec(docText)) !== null) {
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  }
  const id = String(maxNum + 1);
  const refText = `[^${id}]`;

  if (!sel.empty) {
    // Case 3: text selected → move it into the footnote definition
    const selectedText = state.sliceDoc(sel.from, sel.to);
    view.dispatch({
      changes: [
        { from: sel.from, to: sel.to, insert: refText },
        { from: state.doc.length, insert: `\n[^${id}]: ${selectedText}` },
      ],
      selection: { anchor: sel.from + refText.length },
      scrollIntoView: false,
    });
  } else {
    // Case 4: no selection, cursor not in ref → insert blank footnote
    view.dispatch({
      changes: [
        { from: sel.from, insert: refText },
        { from: state.doc.length, insert: `\n[^${id}]: ` },
      ],
      selection: { anchor: sel.from + refText.length },
      scrollIntoView: false,
    });
  }

  view.focus();
  return true;
}

// Every live view carrying the plugin, and the one the user last worked
// in. The document-level handlers are installed once, not once per
// editor: each pane, stack column and card makes a footnote plugin, and
// a handler per instance (each holding its own, possibly destroyed, view)
// ran a click on a footnote once for every editor ever opened.
const liveViews = new Set();
let lastView = null;
let handlersInstalled = false;

function viewFor(el) {
  if (el) for (const v of liveViews) if (v.dom.contains(el)) return v;
  return lastView && liveViews.has(lastView) ? lastView : null;
}

export function createFootnotePlugin(stateRef) {
  _stateRef = stateRef;
  if (!handlersInstalled) {
    handlersInstalled = true;
    setupFootnoteHandlers(stateRef, viewFor, () => liveViews, uiDeps);
    setDropIndicatorFns(showDropIndicator, hideDropIndicator);
  }

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        liveViews.add(view);
        lastView = view;
        this.decorations = buildDecorations(view, stateRef);
        requestAnimationFrame(() => updateMarginalia(view, stateRef, uiDeps));
      }
      update(update) {
        if (update.docChanged || update.selectionSet) lastView = update.view;
        if (isEditing() && !update.viewportChanged) return;
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          // Only this view's overlay: another editor's edit (a card, a
          // pane) is no reason to close it.
          if (!isEditing() && update.view.scrollDOM.contains(getActiveOverlay())) closeOverlay();
          this.decorations = buildDecorations(update.view, stateRef);
          if (!isEditing()) debouncedUpdateMarginalia(update.view, stateRef, uiDeps);
        }
      }
      destroy() {
        liveViews.delete(this.view);
        if (lastView === this.view) lastView = null;
        if (this.view.scrollDOM.contains(getActiveOverlay())) closeOverlay();
        clearMarginalia(this.view);
      }
    },
    { decorations: (v) => v.decorations }
  );
}
