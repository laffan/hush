/**
 * Footnotes — CodeMirror ViewPlugin that decorates [^id] references with
 * clickable colored dots (or underlines for text IDs) and shows footnote
 * definitions as overlays or marginalia depending on margin width.
 *
 * Overlay and marginalia text is contenteditable — edits sync back to
 * the markdown definition in the document.
 */
import { ViewPlugin, Decoration, WidgetType, EditorView } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

// Matches footnote references like [^1], [^note], [^my-ref]
const FOOTNOTE_REF_RE = /\[\^([^\]]+)\]/g;
// Matches footnote definitions like [^1]: Some text here
const FOOTNOTE_DEF_RE = /^\[\^([^\]]+)\]:\s*(.*)/;

// 10 dot colors that cycle
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

function isNumericId(id) {
  return /^\d+$/.test(id);
}

const MARGIN_THRESHOLD = 200;

let activeOverlay = null;
/** Flag to prevent overlay close during editable content interaction */
let editingOverlay = false;

function closeOverlay() {
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
    editingOverlay = false;
  }
}

/**
 * Parse all footnote definitions from the full document text.
 */
function parseDefinitions(doc) {
  const defs = new Map();
  const text = doc.toString();
  const lines = text.split("\n");
  let currentId = null;
  let currentText = "";

  for (const line of lines) {
    const match = line.match(FOOTNOTE_DEF_RE);
    if (match) {
      if (currentId !== null) {
        defs.set(currentId, currentText.trim());
      }
      currentId = match[1];
      currentText = match[2];
    } else if (currentId !== null && /^  /.test(line)) {
      currentText += " " + line.trim();
    } else {
      if (currentId !== null) {
        defs.set(currentId, currentText.trim());
        currentId = null;
        currentText = "";
      }
    }
  }
  if (currentId !== null) {
    defs.set(currentId, currentText.trim());
  }
  return defs;
}

/**
 * Find the range of the definition text for a given footnote id.
 * Returns { from, to } of just the text after "[^id]: ", or null.
 */
function findDefinitionRange(doc, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\[\\^${escapedId}\\]:\\s*`);
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = line.text.match(re);
    if (m) {
      const textFrom = line.from + m[0].length;
      // Include continuation lines (indented with 2+ spaces)
      let textTo = line.to;
      for (let j = i + 1; j <= doc.lines; j++) {
        const nextLine = doc.line(j);
        if (/^  /.test(nextLine.text)) {
          textTo = nextLine.to;
        } else {
          break;
        }
      }
      return { from: textFrom, to: textTo };
    }
  }
  return null;
}

function getMargins() {
  const scroller = document.querySelector("#editor-container .cm-scroller");
  if (!scroller) return { left: 0, right: 0 };
  const left = parseInt(scroller.style.paddingLeft) || 50;
  const right = parseInt(scroller.style.paddingRight) || 50;
  return { left, right };
}

function isWideMargin() {
  const m = getMargins();
  return m.left >= MARGIN_THRESHOLD && m.right >= MARGIN_THRESHOLD;
}

function getFootnoteSettings(stateRef) {
  const s = stateRef.settings || {};
  return {
    fontSize: s.footnoteFontSize || 100,
    fontFamily: s.footnoteFontFamily || "sans-serif",
    useColors: s.footnoteUseColors !== false,
  };
}

function resolveFootnoteFont(fontFamily) {
  if (fontFamily === "match") return "var(--font-family)";
  if (fontFamily === "serif") return "'Georgia', 'Times New Roman', serif";
  return "system-ui, -apple-system, sans-serif";
}

function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    fg: style.getPropertyValue("--fg").trim() || "#e0e0e0",
    bg: style.getPropertyValue("--bg").trim() || "#1a1a1a",
  };
}

/**
 * Sync footnote text back to the document. If no definition line exists,
 * creates one at the end of the document.
 */
function syncFootnoteText(view, id, newText) {
  const doc = view.state.doc;
  const range = findDefinitionRange(doc, id);
  if (range) {
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: newText },
      scrollIntoView: false,
    });
  } else {
    // No definition line exists — create one at document end
    const defLine = `\n[^${id}]: ${newText}`;
    view.dispatch({
      changes: { from: doc.length, insert: defLine },
      scrollIntoView: false,
    });
  }
}

/**
 * Create a contenteditable text element that syncs changes back to the
 * markdown definition in the CodeMirror document.
 */
function createEditableContent(id, defText, view, stateRef) {
  const fsettings = getFootnoteSettings(stateRef);
  const content = document.createElement("div");
  content.className = "footnote-overlay-content";
  content.contentEditable = "true";
  content.spellcheck = false;
  content.textContent = defText || "";
  content.style.fontFamily = resolveFootnoteFont(fsettings.fontFamily);
  content.dataset.footnoteId = id;

  // Prevent CodeMirror from stealing focus/events
  content.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    editingOverlay = true;
  });
  content.addEventListener("keydown", (e) => e.stopPropagation());
  content.addEventListener("keypress", (e) => e.stopPropagation());

  // Sync edits back to the document on input (without scrolling)
  content.addEventListener("input", () => {
    syncFootnoteText(view, id, content.textContent);
  });

  return content;
}

/**
 * Widget that renders a colored dot with the footnote identifier.
 */
class FootnoteDotWidget extends WidgetType {
  constructor(id, defText, color, from, to, stateRef) {
    super();
    this.id = id;
    this.defText = defText;
    this.color = color;
    this.from = from;
    this.to = to;
    this.stateRef = stateRef;
    this.useColors = getFootnoteSettings(stateRef).useColors;
    this.fontFamily = getFootnoteSettings(stateRef).fontFamily;
    this.fontSizePct = getFootnoteSettings(stateRef).fontSize;
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

    const fontCss = resolveFootnoteFont(fsettings.fontFamily);
    dot.style.fontFamily = fontCss;
    const baseFontSize = 9;
    dot.style.fontSize = (baseFontSize * fsettings.fontSize / 100) + "px";

    if (fsettings.useColors) {
      dot.style.backgroundColor = this.color;
      dot.style.color = "#fff";
    } else {
      const colors = getThemeColors();
      dot.style.backgroundColor = colors.fg;
      dot.style.color = colors.bg;
    }

    const self = this;
    dot.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (activeOverlay && activeOverlay.dataset.footnoteId === self.id) {
        closeOverlay();
        return;
      }
      closeOverlay();
      self._showOverlay(dot, view);
    });

    return dot;
  }

  _showOverlay(dot, view) {
    const overlay = document.createElement("div");
    overlay.className = "footnote-overlay";
    overlay.dataset.footnoteId = this.id;

    const closeBtn = document.createElement("button");
    closeBtn.className = "footnote-overlay-close";
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeOverlay();
    });

    const content = createEditableContent(this.id, this.defText, view, this.stateRef);

    overlay.appendChild(closeBtn);
    overlay.appendChild(content);

    const scroller = view.scrollDOM;
    const dotRect = dot.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const paddingLeft = parseInt(scroller.style.paddingLeft) || 50;
    const paddingRight = parseInt(scroller.style.paddingRight) || 50;
    const colWidth = scrollerRect.width - paddingLeft - paddingRight;

    overlay.style.position = "absolute";
    overlay.style.left = paddingLeft + "px";
    overlay.style.width = colWidth + "px";
    overlay.style.top = (dotRect.bottom - scrollerRect.top + scroller.scrollTop + 4) + "px";

    scroller.appendChild(overlay);
    activeOverlay = overlay;
  }

  ignoreEvent() { return true; }
}

/**
 * Build decorations for footnote references.
 * Skips decoration when the cursor is inside a reference range.
 */
function buildDecorations(view, stateRef) {
  // Hide footnote decorations in private mode
  if (stateRef.privateMode) return Decoration.none;

  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  const defs = parseDefinitions(doc);
  const fsettings = getFootnoteSettings(stateRef);

  const cursors = view.state.selection.ranges.map(r => ({
    from: r.from, to: r.to,
  }));

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const lineText = line.text;

    if (FOOTNOTE_DEF_RE.test(lineText)) continue;

    FOOTNOTE_REF_RE.lastIndex = 0;
    let match;
    while ((match = FOOTNOTE_REF_RE.exec(lineText)) !== null) {
      const id = match[1];
      const from = line.from + match.index;
      const to = from + match[0].length;
      const defText = defs.get(id) || "";
      const color = getColorForId(id);

      const cursorInside = cursors.some(c =>
        (c.from >= from && c.from <= to) || (c.to >= from && c.to <= to)
      );
      if (cursorInside) continue;

      if (isNumericId(id)) {
        builder.add(from, to, Decoration.replace({
          widget: new FootnoteDotWidget(id, defText, color, from, to, stateRef),
        }));
      } else {
        const underlineColor = fsettings.useColors ? color : getThemeColors().fg;
        builder.add(from, to, Decoration.mark({
          class: "footnote-underline",
          attributes: {
            style: `border-bottom: 2px solid ${underlineColor};`,
            "data-footnote-id": id,
            title: defText || `Footnote: ${id}`,
          },
        }));
      }
    }
  }

  return builder.finish();
}

/**
 * Create or update marginalia elements for wide-margin mode.
 * Marginalia text is contenteditable. Overlapping notes are pushed down.
 */
function updateMarginalia(view, stateRef) {
  document.querySelectorAll(".footnote-marginalia").forEach(el => el.remove());

  // Hide marginalia in private mode
  if (stateRef.privateMode) return;

  if (!isWideMargin()) return;

  const fsettings = getFootnoteSettings(stateRef);
  const doc = view.state.doc;
  const defs = parseDefinitions(doc);
  const scroller = view.scrollDOM;
  const scrollerRect = scroller.getBoundingClientRect();
  const paddingLeft = parseInt(scroller.style.paddingLeft) || 50;
  const paddingRight = parseInt(scroller.style.paddingRight) || 50;
  const colRight = scrollerRect.width - paddingRight;
  const fontCss = resolveFootnoteFont(fsettings.fontFamily);
  const useBothMargins = stateRef.settings.footnoteBothMargins !== false;

  // Collect all marginalia entries first, then resolve overlaps
  const entries = [];

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const lineText = line.text;
    if (FOOTNOTE_DEF_RE.test(lineText)) continue;

    FOOTNOTE_REF_RE.lastIndex = 0;
    let match;
    while ((match = FOOTNOTE_REF_RE.exec(lineText)) !== null) {
      const id = match[1];
      const defText = defs.get(id);
      if (defText == null) continue; // skip only if no definition line exists at all

      const from = line.from + match.index;
      const coords = view.coordsAtPos(from);
      if (!coords) continue;

      const refX = coords.left - scrollerRect.left;
      const placeLeft = useBothMargins && refX <= scrollerRect.width - refX;
      const naturalTop = coords.top - scrollerRect.top + scroller.scrollTop;

      entries.push({ id, defText, placeLeft, naturalTop });
    }
  }

  // Separate left and right, resolve overlaps per side
  const leftEntries = entries.filter(e => e.placeLeft);
  const rightEntries = entries.filter(e => !e.placeLeft);
  resolveOverlaps(leftEntries);
  resolveOverlaps(rightEntries);

  for (const entry of entries) {
    const color = getColorForId(entry.id);
    const marg = document.createElement("div");
    marg.className = "footnote-marginalia";
    marg.dataset.footnoteId = entry.id;
    marg.style.fontFamily = fontCss;
    const margFontSize = 12 * fsettings.fontSize / 100;
    marg.style.fontSize = margFontSize + "px";

    const label = document.createElement("span");
    label.className = "footnote-marginalia-label";
    label.textContent = entry.id;

    if (fsettings.useColors) {
      label.style.backgroundColor = color;
      label.style.color = "#fff";
    } else {
      const colors = getThemeColors();
      label.style.backgroundColor = colors.fg;
      label.style.color = colors.bg;
    }

    const text = createMarginaliaText(entry.id, entry.defText, view, stateRef);

    marg.appendChild(label);
    marg.appendChild(text);

    const margWidth = Math.min(200, (entry.placeLeft ? paddingLeft : paddingRight) - 40);
    marg.style.position = "absolute";
    marg.style.width = margWidth + "px";
    marg.style.top = entry.top + "px";

    if (entry.placeLeft) {
      marg.style.left = (paddingLeft - margWidth - 30) + "px";
    } else {
      marg.style.left = (colRight + 30) + "px";
    }

    scroller.appendChild(marg);
  }
}

/**
 * Create an editable text span for marginalia.
 */
function createMarginaliaText(id, defText, view, stateRef) {
  const text = document.createElement("span");
  text.className = "footnote-marginalia-text";
  text.contentEditable = "true";
  text.spellcheck = false;
  text.textContent = defText;
  text.addEventListener("mousedown", (e) => {
    e.stopPropagation();
    editingOverlay = true;
  });
  text.addEventListener("keydown", (e) => e.stopPropagation());
  text.addEventListener("keypress", (e) => e.stopPropagation());
  text.addEventListener("focus", () => { editingOverlay = true; });
  text.addEventListener("blur", () => { editingOverlay = false; });
  text.addEventListener("input", () => {
    editingOverlay = true;
    syncFootnoteText(view, id, text.textContent);
  });
  return text;
}

/**
 * Resolve overlapping marginalia on one side. Each entry gets a `top`
 * property. If two entries would overlap, the later one is pushed
 * 20px below the previous one's bottom (estimated).
 */
function resolveOverlaps(entries) {
  // Sort by natural top position
  entries.sort((a, b) => a.naturalTop - b.naturalTop);
  const EST_HEIGHT = 24; // estimated minimum height per marginalia
  for (let i = 0; i < entries.length; i++) {
    const prev = i > 0 ? entries[i - 1] : null;
    const desired = entries[i].naturalTop;
    if (prev && desired < prev.top + EST_HEIGHT + 20) {
      entries[i].top = prev.top + EST_HEIGHT + 20;
    } else {
      entries[i].top = desired;
    }
  }
}

let marginaliaTimeout = null;
function debouncedUpdateMarginalia(view, stateRef) {
  clearTimeout(marginaliaTimeout);
  marginaliaTimeout = setTimeout(() => updateMarginalia(view, stateRef), 100);
}

/**
 * Insert a footnote at the current cursor position.
 */
export function insertFootnote(view) {
  const state = view.state;
  const sel = state.selection.main;
  const doc = state.doc;
  const docText = doc.toString();

  let id;
  if (!sel.empty) {
    id = state.sliceDoc(sel.from, sel.to);
  } else {
    let maxNum = 0;
    FOOTNOTE_REF_RE.lastIndex = 0;
    let m;
    while ((m = FOOTNOTE_REF_RE.exec(docText)) !== null) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > maxNum) maxNum = n;
    }
    id = String(maxNum + 1);
  }

  const ref = `[^${id}]`;
  const defLine = `\n[^${id}]: `;
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const defExists = new RegExp(`^\\[\\^${escapedId}\\]:`, "m").test(docText);

  let changes;
  if (defExists) {
    changes = [{ from: sel.from, to: sel.to, insert: ref }];
  } else {
    const docEnd = doc.length;
    changes = [
      { from: sel.from, to: sel.to, insert: ref },
      { from: docEnd, insert: defLine },
    ];
  }

  // Keep cursor at the reference position (don't jump to definition)
  const cursorPos = sel.from + ref.length;
  view.dispatch({
    changes,
    selection: { anchor: cursorPos },
    scrollIntoView: false,
  });
  view.focus();
  return true;
}

export function createFootnotePlugin(stateRef) {
  // Close overlay on click outside (but not when editing inside it)
  document.addEventListener("mousedown", (e) => {
    if (activeOverlay && !activeOverlay.contains(e.target) &&
        !e.target.classList.contains("footnote-dot") && !editingOverlay) {
      closeOverlay();
    }
    // Reset editing flag on next tick (after the click resolves)
    if (editingOverlay) {
      setTimeout(() => { editingOverlay = false; }, 0);
    }
  });

  // Handle clicks on underline-style footnotes (text IDs) for overlay
  document.addEventListener("click", (e) => {
    const el = e.target.closest(".footnote-underline");
    if (!el) return;
    const id = el.dataset.footnoteId;
    if (!id) return;

    if (activeOverlay && activeOverlay.dataset.footnoteId === id) {
      closeOverlay();
      return;
    }
    closeOverlay();

    const scroller = document.querySelector("#editor-container .cm-scroller");
    if (!scroller || !currentView) return;

    const doc = currentView.state.doc;
    const defs = parseDefinitions(doc);
    const defText = defs.get(id) || "";

    const overlay = document.createElement("div");
    overlay.className = "footnote-overlay";
    overlay.dataset.footnoteId = id;

    const closeBtn = document.createElement("button");
    closeBtn.className = "footnote-overlay-close";
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeOverlay();
    });

    const content = createEditableContent(id, defText, currentView, stateRef);

    overlay.appendChild(closeBtn);
    overlay.appendChild(content);

    const elRect = el.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const paddingLeft = parseInt(scroller.style.paddingLeft) || 50;
    const paddingRight = parseInt(scroller.style.paddingRight) || 50;
    const colWidth = scrollerRect.width - paddingLeft - paddingRight;

    overlay.style.position = "absolute";
    overlay.style.left = paddingLeft + "px";
    overlay.style.width = colWidth + "px";
    overlay.style.top = (elRect.bottom - scrollerRect.top + scroller.scrollTop + 4) + "px";

    scroller.appendChild(overlay);
    activeOverlay = overlay;
  });

  let currentView = null;
  window.addEventListener("resize", () => {
    closeOverlay();
    if (currentView) debouncedUpdateMarginalia(currentView, stateRef);
  });

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        currentView = view;
        this.decorations = buildDecorations(view, stateRef);
        requestAnimationFrame(() => updateMarginalia(view, stateRef));
      }

      update(update) {
        currentView = update.view;
        // Don't rebuild decorations or close overlay while user is editing
        // inside an overlay/marginalia — the input handler syncs changes
        if (editingOverlay && !update.viewportChanged) return;

        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          // Don't close overlay on doc changes triggered by our own edits
          if (!editingOverlay) closeOverlay();
          this.decorations = buildDecorations(update.view, stateRef);
          // Don't rebuild marginalia while editing one
          if (!editingOverlay) {
            debouncedUpdateMarginalia(update.view, stateRef);
          }
        }
      }

      destroy() {
        closeOverlay();
        document.querySelectorAll(".footnote-marginalia").forEach(el => el.remove());
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
