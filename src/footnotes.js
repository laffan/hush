/**
 * Footnotes — CodeMirror ViewPlugin that replaces [^id] references with
 * clickable colored dots and shows footnote definitions as overlays or
 * marginalia depending on available margin width.
 */
import { ViewPlugin, Decoration, WidgetType } from "@codemirror/view";
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
      // Save previous definition
      if (currentId !== null) {
        defs.set(currentId, currentText.trim());
      }
      currentId = match[1];
      currentText = match[2];
    } else if (currentId !== null && /^  /.test(line)) {
      // Continuation line (indented)
      currentText += " " + line.trim();
    } else {
      // End of definition
      if (currentId !== null) {
        defs.set(currentId, currentText.trim());
        currentId = null;
        currentText = "";
      }
    }
  }
  // Save last definition
  if (currentId !== null) {
    defs.set(currentId, currentText.trim());
  }
  return defs;
}

/**
 * Get the current margin size on each side of the content column.
 */
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
 * Widget that renders a colored dot with the footnote identifier.
 */
class FootnoteDotWidget extends WidgetType {
  constructor(id, defText, color) {
    super();
    this.id = id;
    this.defText = defText;
    this.color = color;
  }

  eq(other) {
    return this.id === other.id && this.defText === other.defText;
  }

  toDOM(view) {
    const dot = document.createElement("span");
    dot.className = "footnote-dot";
    dot.style.backgroundColor = this.color;
    dot.textContent = this.id;
    dot.dataset.footnoteId = this.id;
    dot.title = this.defText || `Footnote ${this.id}`;

    dot.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (isWideMargin()) return; // marginalia always visible, no click needed

      // Toggle overlay
      if (activeOverlay && activeOverlay.dataset.footnoteId === this.id) {
        closeOverlay();
        return;
      }
      closeOverlay();
      this._showOverlay(dot, view);
    });

    return dot;
  }

  _showOverlay(dot, view) {
    const overlay = document.createElement("div");
    overlay.className = "footnote-overlay";
    overlay.dataset.footnoteId = this.id;

    const closeBtn = document.createElement("button");
    closeBtn.className = "footnote-overlay-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeOverlay();
    });

    const content = document.createElement("div");
    content.className = "footnote-overlay-content";
    content.textContent = this.defText || `Footnote ${this.id} (undefined)`;

    overlay.appendChild(closeBtn);
    overlay.appendChild(content);

    // Position below the dot within the cm-scroller
    const scroller = view.scrollDOM;
    const dotRect = dot.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();

    // Get the column boundaries from scroller padding
    const paddingLeft = parseInt(scroller.style.paddingLeft) || 50;
    const paddingRight = parseInt(scroller.style.paddingRight) || 50;
    const colLeft = scrollerRect.left + paddingLeft;
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
 * Build decorations: replace [^id] references with dot widgets.
 * Skip lines that are footnote definitions themselves.
 */
function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  const defs = parseDefinitions(doc);

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const lineText = line.text;

    // Skip footnote definition lines
    if (FOOTNOTE_DEF_RE.test(lineText)) continue;

    FOOTNOTE_REF_RE.lastIndex = 0;
    let match;
    while ((match = FOOTNOTE_REF_RE.exec(lineText)) !== null) {
      const id = match[1];
      const from = line.from + match.index;
      const to = from + match[0].length;
      const defText = defs.get(id) || "";
      const color = getColorForId(id);
      builder.add(from, to, Decoration.replace({
        widget: new FootnoteDotWidget(id, defText, color),
      }));
    }
  }

  return builder.finish();
}

/**
 * Create or update marginalia elements for wide-margin mode.
 */
function updateMarginalia(view) {
  // Remove existing marginalia
  document.querySelectorAll(".footnote-marginalia").forEach(el => el.remove());

  if (!isWideMargin()) return;

  const doc = view.state.doc;
  const defs = parseDefinitions(doc);
  const scroller = view.scrollDOM;
  const scrollerRect = scroller.getBoundingClientRect();
  const paddingLeft = parseInt(scroller.style.paddingLeft) || 50;
  const paddingRight = parseInt(scroller.style.paddingRight) || 50;
  const colLeft = paddingLeft;
  const colRight = scrollerRect.width - paddingRight;

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

      const label = document.createElement("span");
      label.className = "footnote-marginalia-label";
      label.style.backgroundColor = color;
      label.textContent = id;

      const text = document.createElement("span");
      text.className = "footnote-marginalia-text";
      text.textContent = defText;

      marg.appendChild(label);
      marg.appendChild(text);

      // Determine which side is closer to the reference position
      const refX = coords.left - scrollerRect.left;
      const distLeft = refX - 0;
      const distRight = scrollerRect.width - refX;
      const margWidth = Math.min(paddingLeft - 20, paddingRight - 20, 180);

      if (distLeft <= distRight) {
        // Place in left margin
        marg.style.left = "10px";
        marg.style.width = (paddingLeft - 20) + "px";
      } else {
        // Place in right margin
        marg.style.left = (colRight + 10) + "px";
        marg.style.width = (paddingRight - 20) + "px";
      }

      marg.style.position = "absolute";
      marg.style.top = (coords.top - scrollerRect.top + scroller.scrollTop) + "px";

      scroller.appendChild(marg);
    }
  }
}

// Debounce helper
let marginaliaTimeout = null;
function debouncedUpdateMarginalia(view) {
  clearTimeout(marginaliaTimeout);
  marginaliaTimeout = setTimeout(() => updateMarginalia(view), 100);
}

export function createFootnotePlugin(stateRef) {
  // Close overlay on click outside
  document.addEventListener("mousedown", (e) => {
    if (activeOverlay && !activeOverlay.contains(e.target) &&
        !e.target.classList.contains("footnote-dot")) {
      closeOverlay();
    }
  });

  // Update marginalia on window resize
  let currentView = null;
  window.addEventListener("resize", () => {
    closeOverlay();
    if (currentView) debouncedUpdateMarginalia(currentView);
  });

  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        currentView = view;
        this.decorations = buildDecorations(view);
        // Schedule marginalia after initial render
        requestAnimationFrame(() => updateMarginalia(view));
      }

      update(update) {
        currentView = update.view;
        if (update.docChanged || update.viewportChanged) {
          closeOverlay();
          this.decorations = buildDecorations(update.view);
          debouncedUpdateMarginalia(update.view);
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
