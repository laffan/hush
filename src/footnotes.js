/**
 * Footnotes — CodeMirror ViewPlugin that decorates [^id] references with
 * clickable colored dots (or underlines for text IDs) and shows footnote
 * definitions as overlays or marginalia depending on margin width.
 *
 * Decorations are skipped when the cursor is inside a footnote reference,
 * allowing normal editing of the raw markdown.
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

/** Returns true if id is purely numeric */
function isNumericId(id) {
  return /^\d+$/.test(id);
}

/** Margin mode threshold — each side must be >= 200px for marginalia */
const MARGIN_THRESHOLD = 200;

/** Currently open overlay element (narrow mode) */
let activeOverlay = null;

function closeOverlay() {
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
}

/**
 * Parse all footnote definitions from the full document text.
 * Supports multi-line definitions (continuation lines indented with 2+ spaces).
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

/**
 * Get settings for footnote display.
 */
function getFootnoteSettings(stateRef) {
  const s = stateRef.settings || {};
  return {
    fontSize: s.footnoteFontSize || 100,
    fontFamily: s.footnoteFontFamily || "sans-serif",
    useColors: s.footnoteUseColors !== false, // default true
  };
}

/**
 * Resolve the font-family CSS value for footnotes.
 */
function resolveFootnoteFont(fontFamily) {
  if (fontFamily === "match") return "var(--font-family)";
  if (fontFamily === "serif") return "'Georgia', 'Times New Roman', serif";
  return "system-ui, -apple-system, sans-serif";
}

/**
 * Get theme background color for no-color mode.
 */
function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    fg: style.getPropertyValue("--fg").trim() || "#e0e0e0",
    bg: style.getPropertyValue("--bg").trim() || "#1a1a1a",
  };
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
  }

  eq(other) {
    return this.id === other.id && this.defText === other.defText &&
           this.color === other.color;
  }

  toDOM(view) {
    const fsettings = getFootnoteSettings(this.stateRef);
    const dot = document.createElement("span");
    dot.className = "footnote-dot";
    dot.textContent = this.id;
    dot.dataset.footnoteId = this.id;
    dot.title = this.defText || `Footnote ${this.id}`;

    // Apply settings
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

      // On double-click, place cursor inside the footnote ref for editing
      if (e.detail >= 2) {
        view.dispatch({
          selection: { anchor: self.from + 2, head: self.to - 1 },
        });
        view.focus();
        return;
      }

      if (isWideMargin()) return;

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
    const fsettings = getFootnoteSettings(this.stateRef);
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

    const content = document.createElement("div");
    content.className = "footnote-overlay-content";
    content.textContent = this.defText || `Footnote ${this.id} (undefined)`;
    content.style.fontFamily = resolveFootnoteFont(fsettings.fontFamily);

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
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  const defs = parseDefinitions(doc);
  const fsettings = getFootnoteSettings(stateRef);

  // Get all cursor positions to check for editability
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

      // If any cursor intersects this range, skip decoration to allow editing
      const cursorInside = cursors.some(c =>
        c.from >= from && c.from <= to || c.to >= from && c.to <= to
      );
      if (cursorInside) continue;

      if (isNumericId(id)) {
        // Numeric ID → dot widget replaces the full [^N] text
        builder.add(from, to, Decoration.replace({
          widget: new FootnoteDotWidget(id, defText, color, from, to, stateRef),
        }));
      } else {
        // Text ID → colored underline on the [^text] range
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
 */
function updateMarginalia(view, stateRef) {
  document.querySelectorAll(".footnote-marginalia").forEach(el => el.remove());

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

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const lineText = line.text;
    if (FOOTNOTE_DEF_RE.test(lineText)) continue;

    FOOTNOTE_REF_RE.lastIndex = 0;
    let match;
    while ((match = FOOTNOTE_REF_RE.exec(lineText)) !== null) {
      const id = match[1];
      const defText = defs.get(id);
      if (!defText) continue;

      const from = line.from + match.index;
      const coords = view.coordsAtPos(from);
      if (!coords) continue;

      const color = getColorForId(id);
      const marg = document.createElement("div");
      marg.className = "footnote-marginalia";
      marg.dataset.footnoteId = id;
      marg.style.fontFamily = fontCss;
      const margFontSize = 12 * fsettings.fontSize / 100;
      marg.style.fontSize = margFontSize + "px";

      const label = document.createElement("span");
      label.className = "footnote-marginalia-label";
      label.textContent = id;

      if (fsettings.useColors) {
        label.style.backgroundColor = color;
        label.style.color = "#fff";
      } else {
        const colors = getThemeColors();
        label.style.backgroundColor = colors.fg;
        label.style.color = colors.bg;
      }

      const text = document.createElement("span");
      text.className = "footnote-marginalia-text";
      text.textContent = defText;

      marg.appendChild(label);
      marg.appendChild(text);

      // Determine which side is closer to the reference position
      const refX = coords.left - scrollerRect.left;
      const distLeft = refX;
      const distRight = scrollerRect.width - refX;

      if (distLeft <= distRight) {
        marg.style.left = "10px";
        marg.style.width = Math.min(paddingLeft - 20, 200) + "px";
      } else {
        marg.style.left = (colRight + 10) + "px";
        marg.style.width = Math.min(paddingRight - 20, 200) + "px";
      }

      marg.style.position = "absolute";
      marg.style.top = (coords.top - scrollerRect.top + scroller.scrollTop) + "px";

      scroller.appendChild(marg);
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
 * If text is selected, use selection as the footnote ID.
 * Otherwise, auto-increment a numeric ID.
 */
export function insertFootnote(view) {
  const state = view.state;
  const sel = state.selection.main;
  const doc = state.doc;
  const docText = doc.toString();

  let id;
  if (!sel.empty) {
    // Use selected text as ID
    id = state.sliceDoc(sel.from, sel.to);
  } else {
    // Find the next available numeric ID
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

  // Check if a definition already exists
  const defExists = new RegExp(`^\\[\\^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]:`, "m").test(docText);

  let changes;
  if (defExists) {
    // Just insert the reference at cursor
    changes = [{ from: sel.from, to: sel.to, insert: ref }];
  } else {
    // Insert reference at cursor + definition at end of document
    const docEnd = doc.length;
    changes = [
      { from: sel.from, to: sel.to, insert: ref },
      { from: docEnd, insert: defLine },
    ];
  }

  view.dispatch({
    changes,
    selection: defExists
      ? { anchor: sel.from + ref.length }
      : { anchor: doc.length + defLine.length + (ref.length - (sel.to - sel.from)) },
  });
  view.focus();
  return true;
}

export function createFootnotePlugin(stateRef) {
  document.addEventListener("mousedown", (e) => {
    if (activeOverlay && !activeOverlay.contains(e.target) &&
        !e.target.classList.contains("footnote-dot")) {
      closeOverlay();
    }
  });

  // Handle clicks on underline-style footnotes (text IDs)
  document.addEventListener("click", (e) => {
    const el = e.target.closest(".footnote-underline");
    if (!el || isWideMargin()) return;
    const id = el.dataset.footnoteId;
    if (!id) return;

    if (activeOverlay && activeOverlay.dataset.footnoteId === id) {
      closeOverlay();
      return;
    }
    closeOverlay();

    // Show overlay below the underlined element
    const fsettings = getFootnoteSettings(stateRef);
    const scroller = document.querySelector("#editor-container .cm-scroller");
    if (!scroller) return;

    const doc = currentView?.state?.doc;
    if (!doc) return;
    const defs = parseDefinitions(doc);
    const defText = defs.get(id) || `Footnote ${id} (undefined)`;

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

    const content = document.createElement("div");
    content.className = "footnote-overlay-content";
    content.textContent = defText;
    content.style.fontFamily = resolveFootnoteFont(fsettings.fontFamily);

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
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          closeOverlay();
          this.decorations = buildDecorations(update.view, stateRef);
          debouncedUpdateMarginalia(update.view, stateRef);
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
