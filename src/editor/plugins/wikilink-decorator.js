/**
 * Obsidian-style `[[Note Title]]` inter-note links inside the doc
 * editor.
 *
 * Two responsibilities:
 *   1. Decorate every `[[Title]]` span as a clickable link widget when
 *      the cursor isn't inside the braces. Cmd+click opens the
 *      referenced doc / notebook; broken links render with a dashed
 *      underline so the gap is visible.
 *   2. When the user types the second `[` of `[[`, pop a floating search
 *      over every linkable note. Typing narrows the list; Arrow keys
 *      move the highlight; Enter commits (inserting `]]` after the title
 *      and closing the popup); Esc cancels; typing `]]` or moving the
 *      cursor outside the open bracket pair also closes the popup.
 */

import { ViewPlugin, Decoration, WidgetType, EditorView, keymap } from "@codemirror/view";
import { RangeSetBuilder, Prec } from "@codemirror/state";
import { isIOS } from "../../settings/settings-ui.js";
import { resolveWikilink, openWikilink, getLinkableNotes, getActiveNoteNodeId } from "../../links/wikilink-index.js";
import { openWikilinkPopup } from "../../links/wikilink-popup.js";

const WIKILINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

class WikilinkWidget extends WidgetType {
  constructor(title, broken, occurrence, fileType, showInlineArrow) {
    super();
    this.title = title;
    this.broken = !!broken;
    // Nth occurrence of this title in the doc (0-based). Lets the inline
    // pane plugin tell two `[[Same Title]]` widgets apart.
    this.occurrence = occurrence | 0;
    // null when broken; otherwise the resolved target's type.
    this.fileType = fileType || null;
    // Inline-pane affordance is only rendered in editors that host them
    // (the main doc editor). Pane editors leave the arrow off entirely.
    this.showInlineArrow = !!showInlineArrow;
  }

  eq(other) {
    return this.title === other.title
      && this.broken === other.broken
      && this.occurrence === other.occurrence
      && this.fileType === other.fileType
      && this.showInlineArrow === other.showInlineArrow;
  }

  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "cm-wikilink-wrap";
    const span = document.createElement("span");
    span.className = "cm-wikilink-rendered" + (this.broken ? " broken" : "");
    span.textContent = this.title;
    span.title = this.broken ? "No note named \"" + this.title + "\"" : this.title;
    span.dataset.wikilink = this.title;
    wrap.appendChild(span);
    // Down-arrow button — opens the target as a pane embedded in the
    // doc text just below this line. Resolved wikilinks only (nothing
    // to embed for broken links), and only in editors that opted in.
    if (!this.broken && this.showInlineArrow) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cm-wikilink-arrow";
      btn.dataset.wikilink = this.title;
      btn.dataset.occurrence = String(this.occurrence);
      if (this.fileType) btn.dataset.linkType = this.fileType;
      btn.setAttribute("aria-label", "Open inline pane");
      btn.title = "Open inline pane";
      btn.innerHTML = `<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><polyline points="2.5,4 5,6.5 7.5,4" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      wrap.appendChild(btn);
    }
    return wrap;
  }

  ignoreEvent() { return false; }
}

function buildDecorations(view, appState, showInlineArrow) {
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  const cursors = view.state.selection.ranges.map((r) => ({
    from: Math.min(r.from, r.to),
    to: Math.max(r.from, r.to),
  }));
  // Per-title occurrence counter so two `[[Same Title]]` widgets in the
  // same doc carry distinct indices — the inline-pane plugin keys block
  // widgets by (title, occurrence).
  const occCount = new Map();

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    WIKILINK_RE.lastIndex = 0;
    let match;
    while ((match = WIKILINK_RE.exec(line.text)) !== null) {
      const from = line.from + match.index;
      const to = from + match[0].length;
      const title = match[1].trim();
      if (!title) continue;
      const key = title.toLowerCase();
      const occurrence = occCount.get(key) || 0;
      occCount.set(key, occurrence + 1);
      // Reveal the raw `[[title]]` only while the selection is inside
      // this link, so the user can edit it. A link merely swept up in a
      // larger selection stays rendered — see link-decorator.js.
      if (cursors.some((c) => c.from >= from && c.to <= to)) continue;

      const note = appState ? resolveWikilink(appState, title) : null;
      builder.add(from, to, Decoration.replace({
        widget: new WikilinkWidget(title, !note, occurrence, note?.type || null, showInlineArrow),
      }));
    }
  }
  return builder.finish();
}

/** Find an open `[[…` whose closing `]]` hasn't been typed yet, with the
 *  cursor inside. Returns `{ from, to }` of the inner query span, or
 *  null. `from` is the offset just past `[[`; `to` is the cursor head. */
function findActiveWikilinkContext(state) {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const text = line.text;
  const localCursor = head - line.from;
  // Scan backwards from cursor for `[[` that hasn't been closed yet.
  let openIdx = -1;
  for (let i = localCursor - 1; i >= 1; i--) {
    if (text[i] === "]" && text[i - 1] === "]") return null; // closed pair earlier
    if (text[i] === "[" && text[i - 1] === "[") { openIdx = i + 1; break; }
    if (text[i] === "\n") return null;
  }
  if (openIdx < 0) return null;
  // Reject if the open-bracket pair is followed by a closing `]]` before
  // the cursor — the user already finished one and we shouldn't reopen.
  const between = text.slice(openIdx, localCursor);
  if (between.includes("]]") || between.includes("\n")) return null;
  return { from: line.from + openIdx, to: head, query: between };
}

const IS_TAURI = typeof window !== "undefined" && window.__TAURI_INTERNALS__;

/** Match `linkAtPos` in link-decorator for raw wikilink text — used by
 *  the click handler when the cursor sits inside the brackets and the
 *  widget isn't shown. */
function wikilinkAtPos(doc, pos) {
  const line = doc.lineAt(pos);
  WIKILINK_RE.lastIndex = 0;
  let match;
  while ((match = WIKILINK_RE.exec(line.text)) !== null) {
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (pos >= from && pos <= to) return { from, to, title: match[1].trim() };
  }
  return null;
}

/** On iOS, modifier state from a paired keyboard doesn't always reach
 *  touch-synthesized events — mirror link-decorator's tracker. */
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

function tryOpenWikilinkAt(e, view, appState) {
  const widget = e.target.closest(".cm-wikilink-rendered");
  if (widget && widget.dataset.wikilink) {
    e.preventDefault();
    void openWikilink(appState, widget.dataset.wikilink);
    return true;
  }
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos == null) return false;
  const link = wikilinkAtPos(view.state.doc, pos);
  if (link) {
    e.preventDefault();
    void openWikilink(appState, link.title);
    return true;
  }
  return false;
}

function createClickHandler(appState, opts) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      // Inline-pane arrow: open a pinned pane embedded under the wikilink.
      // The arrow is a button — stop the mousedown from triggering the
      // normal cmd-click-to-open path, since the click handler below
      // routes through the same target resolver.
      const arrow = e.target.closest && e.target.closest(".cm-wikilink-arrow");
      if (arrow) {
        e.preventDefault();
        e.stopPropagation();
        const title = arrow.dataset.wikilink;
        const occurrence = parseInt(arrow.dataset.occurrence || "0", 10) || 0;
        if (opts?.onInlinePaneRequest && title) {
          void opts.onInlinePaneRequest(view, { title, occurrence });
        }
        return true;
      }
      if (!hasModifier(e)) return false;
      return tryOpenWikilinkAt(e, view, appState);
    },
  });
}

/**
 * Search controller — owns the popup lifecycle for a single editor.
 * The CodeMirror plugin instance below delegates open / update / close
 * through here so dispatch + DOM stay in sync.
 */
function createSearchController(view, appState) {
  let popup = null;
  let activeRange = null; // { from, to } of the inner query span
  let scheduled = false;

  function close() {
    if (popup) {
      popup.destroy();
      popup = null;
    }
    activeRange = null;
  }

  function anchorAt(pos) {
    const coords = view.coordsAtPos(pos);
    if (!coords) return null;
    return { left: coords.left, top: coords.top, bottom: coords.bottom };
  }

  function pick(note) {
    if (!activeRange) return;
    if (!note) { close(); return; }
    // Replace the inner query with the chosen title, then add `]]` and
    // place the cursor after the closing brackets.
    const insert = note.name + "]]";
    view.dispatch({
      changes: { from: activeRange.from, to: activeRange.to, insert },
      selection: { anchor: activeRange.from + insert.length },
    });
    close();
  }

  function runSync() {
    const ctx = findActiveWikilinkContext(view.state);
    if (!ctx) { close(); return; }
    activeRange = { from: ctx.from, to: ctx.to };
    const notes = getLinkableNotes(appState);
    const excludeId = getActiveNoteNodeId(appState);
    if (!popup) {
      const anchor = anchorAt(ctx.from);
      if (!anchor) return;
      popup = openWikilinkPopup({
        notes,
        excludeId,
        anchor,
        initialQuery: ctx.query,
        onPick: (n) => pick(n),
      });
    } else {
      popup.update(ctx.query);
      const anchor = anchorAt(ctx.from);
      if (anchor) popup.setAnchor(anchor);
    }
  }

  // `sync()` reads layout via `view.coordsAtPos`, which CodeMirror
  // forbids during a ViewPlugin.update() pass — defer to a microtask
  // so the update completes before we measure.
  function sync() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      runSync();
    });
  }

  return {
    sync,
    close,
    moveSelection(delta) { popup?.moveSelection(delta); },
    commit() { popup?.commit(); },
    isOpen() { return !!popup; },
  };
}

export function createWikilinkPlugin(appState, opts) {
  let controller = null;
  const showInlineArrow = !!opts?.onInlinePaneRequest;

  const renderPlugin = ViewPlugin.fromClass(
    class {
      constructor(view) {
        controller = createSearchController(view, appState);
        this.decorations = buildDecorations(view, appState, showInlineArrow);
        // Re-render decorations when the file tree changes — links to a
        // renamed or newly-created note should resolve immediately.
        this._onFilesChanged = () => {
          // Defer — the rename event can fire while a transaction is
          // already in flight (the rename caller dispatches via the
          // sync layer, which can sit inside an update tick).
          queueMicrotask(() => {
            this.decorations = buildDecorations(view, appState, showInlineArrow);
            view.dispatch({});
          });
        };
        appState?.on?.("files-changed", this._onFilesChanged);
      }
      update(update) {
        if (update.docChanged || update.selectionSet || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, appState, showInlineArrow);
        }
        if (update.docChanged || update.selectionSet) {
          controller?.sync();
        }
      }
      destroy() {
        appState?.off?.("files-changed", this._onFilesChanged);
        controller?.close();
      }
    },
    { decorations: (v) => v.decorations },
  );

  // Keymap — Prec.highest so Arrow / Enter / Tab / Esc reach the popup
  // before CodeMirror's default cursor-movement bindings consume them
  // (which would move the caret out of the `[[…` context and close the
  // popup via the selectionSet branch in update()).
  const wikilinkKeymap = Prec.highest(keymap.of([
    { key: "ArrowDown", run: () => controller?.isOpen() ? (controller.moveSelection(1), true) : false },
    { key: "ArrowUp",   run: () => controller?.isOpen() ? (controller.moveSelection(-1), true) : false },
    { key: "Enter",     run: () => controller?.isOpen() ? (controller.commit(), true) : false },
    { key: "Tab",       run: () => controller?.isOpen() ? (controller.commit(), true) : false },
    { key: "Escape",    run: () => controller?.isOpen() ? (controller.close(), true) : false },
  ]));

  return [renderPlugin, wikilinkKeymap, createClickHandler(appState, opts)];
}
