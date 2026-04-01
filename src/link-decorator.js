/**
 * Markdown link decorator — hides URL portion of [text](url) links
 * when the cursor is not inside them, and makes rendered links clickable.
 *
 * Cmd+click (Ctrl+click on non-Mac) opens the link URL.
 */
import { ViewPlugin, Decoration, WidgetType, EditorView } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { isIOS } from "./settings-ui.js";

// Matches [text](url) but not ![alt](img)
const LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;

class LinkWidget extends WidgetType {
  constructor(text, url) {
    super();
    this.text = text;
    this.url = url;
  }

  eq(other) {
    return this.text === other.text && this.url === other.url;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-link-rendered";
    span.textContent = this.text;
    span.title = this.url;
    span.dataset.linkUrl = this.url;
    return span;
  }

  ignoreEvent() { return false; }
}

/** Find the link at a given document position, or null. */
function linkAtPos(doc, pos) {
  const line = doc.lineAt(pos);
  LINK_RE.lastIndex = 0;
  let match;
  while ((match = LINK_RE.exec(line.text)) !== null) {
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (pos >= from && pos <= to) {
      return { from, to, text: match[1], url: match[2] };
    }
  }
  return null;
}

function buildDecorations(view) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  const cursors = view.state.selection.ranges.map(r => ({
    from: Math.min(r.from, r.to),
    to: Math.max(r.from, r.to),
  }));

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    LINK_RE.lastIndex = 0;
    let match;
    while ((match = LINK_RE.exec(line.text)) !== null) {
      const from = line.from + match.index;
      const to = from + match[0].length;
      const text = match[1];
      const url = match[2];

      // Skip if any cursor/selection overlaps this link
      const cursorInside = cursors.some(c =>
        (c.from >= from && c.from <= to) || (c.to >= from && c.to <= to) ||
        (c.from <= from && c.to >= to)
      );
      if (cursorInside) continue;

      builder.add(from, to, Decoration.replace({
        widget: new LinkWidget(text, url),
      }));
    }
  }
  return builder.finish();
}

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function openUrl(url) {
  if (IS_TAURI) {
    try {
      const shell = await import("@tauri-apps/plugin-shell");
      await shell.open(url);
    } catch (_) {
      window.open(url, "_blank");
    }
  } else {
    window.open(url, "_blank");
  }
}

/** Try to find and open a link at the event coordinates. */
function tryOpenLinkAt(e, view) {
  // Case 1: clicked on a rendered widget
  const target = e.target.closest(".cm-link-rendered");
  if (target && target.dataset.linkUrl) {
    e.preventDefault();
    openUrl(target.dataset.linkUrl);
    return true;
  }

  // Case 2: cursor is inside raw link text (widget not shown)
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos != null) {
    const link = linkAtPos(view.state.doc, pos);
    if (link) {
      e.preventDefault();
      openUrl(link.url);
      return true;
    }
  }

  return false;
}

/**
 * On iPadOS, modifier key state from an external keyboard is not
 * reliably propagated into touch-synthesized mouse events. We track
 * Ctrl/Cmd state independently via keydown/keyup so we can check it
 * when a tap occurs.
 */
let _modifierHeld = false;
if (isIOS()) {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Meta" || e.key === "Control") _modifierHeld = true;
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === "Meta" || e.key === "Control") _modifierHeld = false;
  });
  window.addEventListener("blur", () => { _modifierHeld = false; });
}

function hasModifier(e) {
  return e.metaKey || e.ctrlKey || _modifierHeld;
}

/**
 * Editor-level Cmd+click handler. Checks if the click lands on a
 * rendered link widget OR inside raw link syntax, and opens the URL.
 */
const linkClickHandler = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!hasModifier(e)) return false;
    return tryOpenLinkAt(e, view);
  },
});

export function createLinkDecoratorPlugin() {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = buildDecorations(view);
      }
      update(update) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
  return [plugin, linkClickHandler];
}
