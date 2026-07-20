/**
 * Markdown link decorator — hides URL portion of [text](url) links
 * when the cursor is not inside them, and makes rendered links clickable.
 *
 * Cmd+click (Ctrl+click on non-Mac) opens the link URL.
 */
import { ViewPlugin, Decoration, WidgetType, EditorView } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { isIOS } from "../../settings/settings-ui.js";
import { focusSentenceBounds } from "./focus-mode.js";

// Matches [text](url) but not ![alt](img)
const LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;

class LinkWidget extends WidgetType {
  constructor(text, url, dimmed) {
    super();
    this.text = text;
    this.url = url;
    this.dimmed = !!dimmed;
  }

  eq(other) {
    return this.text === other.text && this.url === other.url && this.dimmed === other.dimmed;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-link-rendered" + (this.dimmed ? " focus-mode-dim" : "");
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
    if (match[1].startsWith("@")) continue; // citation — handled by citation-decorator
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (pos >= from && pos <= to) {
      return { from, to, text: match[1], url: match[2] };
    }
  }
  return null;
}

function buildDecorations(view, appState) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  const cursors = view.state.selection.ranges.map(r => ({
    from: Math.min(r.from, r.to),
    to: Math.max(r.from, r.to),
  }));
  // Bake focus-mode dimming directly into the LinkWidget's DOM. Mark
  // decorations from focus-mode.js wrap surrounding text in a
  // `.focus-mode-dim` span, but `Decoration.replace` widgets render as
  // their own elements outside that span — so links would otherwise
  // stay at full opacity even when the rest of the line is dimmed.
  const focusBounds = appState ? focusSentenceBounds(view, appState) : null;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    LINK_RE.lastIndex = 0;
    let match;
    while ((match = LINK_RE.exec(line.text)) !== null) {
      // `[@citekey](url)` is a citation, not a link — the citation
      // decorator renders those with visible brackets and a hover card.
      if (match[1].startsWith("@")) continue;
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

      const dimmed = focusBounds
        ? (to <= focusBounds.from || from >= focusBounds.to)
        : false;

      builder.add(from, to, Decoration.replace({
        widget: new LinkWidget(text, url, dimmed),
      }));
    }
  }
  return builder.finish();
}

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

async function openUrl(url, anchor) {
  // Internal PDF-bookmark deep links (`hush-pdf://<fileId>/<bookmarkId>`)
  // navigate inside the app instead of hitting the OS opener.
  if (url && url.startsWith("hush-pdf://")) {
    try {
      const { openPdfBookmarkUrl } = await import("../../pdf/pdf-bookmarks.js");
      openPdfBookmarkUrl(url);
    } catch (e) { console.warn("PDF bookmark link failed:", e); }
    return;
  }
  // Zotero deep links get a tooltip menu at the click point — "Open in
  // Zotero" vs "Open in Hush" / "Download to Hush" (see zotero-link-menu).
  if (url && url.startsWith("zotero://")) {
    try {
      const { openZoteroLinkMenu } = await import("../../links/zotero-link-menu.js");
      openZoteroLinkMenu(url, anchor);
      return;
    } catch (e) { console.warn("Zotero link menu failed:", e); /* fall through to opener */ }
  }
  if (IS_TAURI) {
    try {
      // tauri-plugin-opener works on both macOS and iOS
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.openUrl(url);
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
    openUrl(target.dataset.linkUrl, target);
    return true;
  }

  // Case 2: cursor is inside raw link text (widget not shown)
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos != null) {
    const link = linkAtPos(view.state.doc, pos);
    if (link) {
      e.preventDefault();
      openUrl(link.url, { x: e.clientX, y: e.clientY });
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

export function createLinkDecoratorPlugin(appState) {
  const plugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.lastFocusMode = !!appState?.focusMode;
        this.decorations = buildDecorations(view, appState);
      }
      update(update) {
        // Rebuild on focus-mode toggle as well as the usual triggers —
        // toggling focus changes which links should be dimmed but
        // doesn't fire docChanged / selectionSet on its own.
        const focusToggled = !!appState?.focusMode !== this.lastFocusMode;
        this.lastFocusMode = !!appState?.focusMode;
        if (focusToggled || update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildDecorations(update.view, appState);
        }
      }
    },
    { decorations: (v) => v.decorations }
  );
  return [plugin, linkClickHandler];
}
